// THE ASYNC PART. Holds what has arrived, what is in flight, and what is
// merely wanted -- and decides when to turn the last into the second.
//
// It talks to the outside through exactly one function, `fetchRange(lo, hi)`.
// It does not know what the bytes are for.

import { createEstimator } from "./estimate.js";
import { planRuns } from "./plan.js";
import { normalise, subtract, total } from "./intervals.js";

const DEFAULTS = {
  concurrency: 4,
  maxWait: 40,       // ms a `fill` request may wait for company
  maxRun: 4 << 20,   // 4 MiB, so one run cannot stall the queue
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h),
};

export function createScheduler(opts = {}) {
  const P = { ...DEFAULTS, ...opts };
  if (typeof P.fetchRange !== "function") throw new Error("fetchRange is required");
  const est = P.estimator || createEstimator(opts.estimate);

  let arrived = [];        // bytes we have
  let inFlight = [];       // bytes someone is already fetching
  let pending = [];        // bytes wanted, not yet dispatched
  let active = 0, timer = null, pendingUrgent = false;
  // THE ACCUMULATION WINDOW IS PAID ONCE PER BATCH. Once a batch has gone out
  // -- deadline, knee or urgency -- whatever the concurrency cap left behind
  // has finished accumulating, and `released` lets it follow as room frees.
  // Before this, every wave re-armed maxWait: 32 fill runs at concurrency 4
  // took 547 ms against 223 ms immediate on a 26 ms / 23 MB/s link, eight
  // waves each waiting 40 ms for company that was already queued.
  let released = false;
  const waiters = [];      // { ranges, resolve, reject }
  const stats = { requests: 0, runs: 0, bytesFetched: 0, bytesWasted: 0, deduped: 0,
                  samplesFitted: 0, samplesShared: 0, samplesStalled: 0 };
  // Transfers on the wire now, each marked if it ever shared the link.
  const live = new Set();

  const covered = (ranges) => subtract(ranges, arrived).length === 0;

  function settleWaiters() {
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (covered(waiters[i].ranges)) waiters.splice(i, 1)[0].resolve();
    }
  }

  function failWaiters(err) {
    // A failed run cannot be told apart from an unrelated one at this level,
    // so every outstanding waiter hears about it rather than hanging forever.
    while (waiters.length) waiters.pop().reject(err);
  }

  async function dispatch(runs) {
    inFlight = normalise([...inFlight, ...runs]);
    for (const run of runs) {
      active++;
      const t0 = P.now();
      // ONLY A TRANSFER THAT HAD THE LINK TO ITSELF IS A SAMPLE. The model is
      // elapsed = overhead + bytes / throughput for ONE transfer; with others
      // in flight on the same pipe, elapsed also counts their bytes. Measured
      // over a 26 ms / 23 MB/s shared pipe at concurrency 4, in rounds-v3's
      // page, the old fit read 57.9 ms and 1.2 MB/s. Discounting instead --
      // charging each transfer its departure-based service time -- read
      // 15.8 ms on the same record, because overlapped round trips vanish.
      // A clean sample needs no model of the link at all.
      const me = { shared: live.size > 0 };
      for (const o of live) o.shared = true;
      live.add(me);
      // WHATEVER fetchRange DOES BECOMES A PROMISE. Called bare, a synchronous
      // throw escaped request() after `active` was raised and the bytes were
      // marked in flight, so neither was ever undone: one throw at
      // concurrency 1 wedged the scheduler for good. A plain return value
      // failed the same way on `.then`.
      //
      // Called synchronously, not deferred through Promise.resolve().then():
      // deferring moved every dispatch onto a microtask and broke the
      // guarantee that `immediate` means now -- five tests caught it.
      let sent;
      try { sent = Promise.resolve(P.fetchRange(run.lo, run.hi)); }
      catch (err) { sent = Promise.reject(err); }
      sent.then(
        () => {
          live.delete(me);
          if (me.shared) stats.samplesShared++;
          else {
            const r = est.observe(run.hi - run.lo, P.now() - t0);
            if (r === "stall") stats.samplesStalled++; else if (r === "fitted") stats.samplesFitted++;
          }
          arrived = normalise([...arrived, run]);
          stats.bytesFetched += run.hi - run.lo;
          stats.runs++;
        },
        (err) => { live.delete(me); failWaiters(err); },
      ).then(() => {
        active--;
        inFlight = subtract(inFlight, [run]);
        settleWaiters();
        pump();
      });
    }
  }

  // Send what is worth sending. `force` is what `immediate` and the deadline
  // both use: dispatch regardless of how little has accumulated.
  function pump(force = false) {
    if (!pending.length || active >= P.concurrency) return;
    // URGENCY STICKS TO THE BYTES, not to the call that dispatched them. When
    // the concurrency cap defers part of an `immediate` request, that part is
    // still immediate: demoting it to `fill` makes a jump to a brand new view
    // wait out a bulk window, which is the one thing `immediate` exists to
    // prevent. A test caught this; nothing else would have.
    const urgent = force || pendingUrgent || released;
    const gap = est.knee();
    const plan = planRuns(pending, { held: arrived, inFlight, gap, maxRun: P.maxRun });
    if (!plan.runs.length) { pending = []; pendingUrgent = false; released = false; settleWaiters(); return; }
    if (!urgent && plan.needBytes < gap) {
      if (timer === null) {
        timer = P.setTimer(() => { timer = null; pump(true); }, P.maxWait);
      }
      return;
    }
    if (timer !== null) { P.clearTimer(timer); timer = null; }
    stats.bytesWasted += plan.waste;
    // ROOM IS COMPUTED ONCE. dispatch() raises `active` synchronously, so
    // asking a second time returns a smaller slice -- and every run in the
    // difference would be both dispatched and requeued, fetching the same
    // bytes twice. That is the exact mistake this repo exists to prevent.
    const room = Math.max(1, P.concurrency - active);
    const sent = plan.runs.slice(0, room);
    const left = plan.runs.slice(room);
    // Anything the concurrency cap left behind goes back on the queue rather
    // than being dropped -- it is still wanted.
    pending = left.length ? normalise(left) : [];
    if (!pending.length) pendingUrgent = false;
    released = pending.length > 0;
    dispatch(sent);
  }

  return {
    estimator: est,

    // Resolves once every byte in `ranges` has arrived. `immediate` skips the
    // accumulation window: a view that jumped somewhere new cannot wait for a
    // bulk to fill, because the user is looking at nothing.
    request(ranges, { priority = "fill" } = {}) {
      const want = normalise(ranges);
      stats.requests++;
      if (!want.length || covered(want)) return Promise.resolve();
      const fresh = subtract(want, arrived);
      stats.deduped += total(want) - total(fresh);
      pending = normalise([...pending, ...fresh]);
      if (priority === "immediate") pendingUrgent = true;
      const p = new Promise((resolve, reject) => waiters.push({ ranges: want, resolve, reject }));
      pump(priority === "immediate");
      return p;
    },

    // What the caller already has, so a warm cache is not re-fetched on reload.
    seed(ranges) { arrived = normalise([...arrived, ...ranges]); settleWaiters(); },
    forget(ranges) { arrived = subtract(arrived, ranges); },

    stats: () => ({ ...stats, knee: est.knee(), overheadMs: est.overheadMs,
                    bytesPerMs: est.bytesPerMs, measured: est.measured,
                    heldBytes: total(arrived), pendingBytes: total(pending),
                    inFlightBytes: total(inFlight), active }),
  };
}
