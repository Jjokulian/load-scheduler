// node test/schedule.js
//
// Time and the network are both injected, so none of this sleeps and none of
// it is flaky.
import { createScheduler } from "../lib/schedule.js";

let pass = 0, fail = 0;
const ok = (c, what) => { c ? pass++ : (fail++, console.log(`  FAIL ${what}`)); };
const eq = (got, want, what) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; return; }
  fail++; console.log(`  FAIL ${what}\n       got  ${a}\n       want ${b}`);
};
const group = (n) => console.log("\n" + n);
const R = (...pairs) => pairs.map(([lo, hi]) => ({ lo, hi }));
const tick = () => new Promise((r) => setTimeout(r, 0));

// A fake link: records every range asked for, and hands back control over when
// each one completes.
function harness(opts = {}) {
  const calls = [];
  let pendingResolvers = [];
  const timers = [];
  const fetchRange = (lo, hi) => {
    calls.push([lo, hi]);
    if (opts.manual) return new Promise((res) => pendingResolvers.push(res));
    return Promise.resolve();
  };
  const s = createScheduler({
    fetchRange,
    now: () => 0,
    setTimer: (fn) => { timers.push(fn); return timers.length - 1; },
    clearTimer: (h) => { timers[h] = null; },
    ...opts,
  });
  return {
    s, calls, timers,
    fireTimers: () => { const t = timers.splice(0); for (const fn of t) if (fn) fn(); },
    settleAll: () => { const r = pendingResolvers.splice(0); for (const res of r) res(); },
    bytes: () => calls.reduce((n, [lo, hi]) => n + (hi - lo), 0),
  };
}

group("an immediate request goes out at once");
{
  const h = harness();
  const p = h.s.request(R([0, 4096]), { priority: "immediate" });
  ok(h.calls.length === 1, "dispatched without waiting for a bulk window");
  await p;
  ok(true, "and the promise resolves when the bytes land");
}

group("a fill request waits for company");
{
  const h = harness({ maxWait: 40 });
  const p = h.s.request(R([0, 4096]), { priority: "fill" });
  ok(h.calls.length === 0, "a small fill request does not go out immediately");
  ok(h.timers.length === 1, "a deadline is armed instead");
  h.fireTimers();
  ok(h.calls.length === 1, "and it goes out when the deadline fires");
  await p;
}

group("a fill request large enough to reach the knee goes at once");
{
  const h = harness();
  const knee = h.s.estimator.knee();
  h.s.request(R([0, knee + 1]), { priority: "fill" });
  ok(h.calls.length === 1, "past the knee there is nothing to gain by waiting");
}

group("the same bytes are never fetched twice");
{
  const h = harness({ manual: true });
  const a = h.s.request(R([0, 4096]), { priority: "immediate" });
  ok(h.calls.length === 1, "first request dispatches");
  const b = h.s.request(R([0, 4096]), { priority: "immediate" });
  ok(h.calls.length === 1, "a duplicate while in flight dispatches nothing");
  h.settleAll();
  await a; await b;
  ok(h.calls.length === 1, "both callers were served by the one transfer");
  const c = h.s.request(R([0, 4096]), { priority: "immediate" });
  await c;
  ok(h.calls.length === 1, "and a repeat after arrival dispatches nothing");
}

group("overlapping requests fetch only the difference");
{
  const h = harness({ manual: true });
  h.s.request(R([0, 8192]), { priority: "immediate" });
  h.settleAll(); await tick();
  h.s.request(R([4096, 12288]), { priority: "immediate" });
  eq(h.calls[1], [8192, 12288], "only the part not already held");
  h.settleAll(); await tick();
}

group("seeded bytes are not fetched");
{
  const h = harness();
  h.s.seed(R([0, 4096]));
  await h.s.request(R([0, 4096]), { priority: "immediate" });
  ok(h.calls.length === 0, "a warm cache costs nothing");
  await h.s.request(R([0, 8192]), { priority: "immediate" });
  eq(h.calls[0], [4096, 8192], "and only the remainder is asked for");
}

group("concurrency is capped, and the remainder is not lost");
{
  const h = harness({ manual: true, concurrency: 2 });
  // Four far-apart ranges, too distant to bridge.
  h.s.request(R([0, 4096], [1 << 24, (1 << 24) + 4096],
                [2 << 24, (2 << 24) + 4096], [3 << 24, (3 << 24) + 4096]),
              { priority: "immediate" });
  ok(h.calls.length <= 2, `at most 2 in flight (saw ${h.calls.length})`);
  const first = h.calls.length;
  h.settleAll(); await tick(); await tick();
  ok(h.calls.length > first, "the queued remainder goes out afterwards");
  h.settleAll(); await tick(); await tick();
  const seen = new Set(h.calls.map((c) => c.join(":")));
  ok(seen.size === h.calls.length, "no range was dispatched twice");
}

group("a failed transfer rejects rather than hanging");
{
  const calls = [];
  const s = createScheduler({
    fetchRange: (lo, hi) => { calls.push([lo, hi]); return Promise.reject(new Error("boom")); },
    now: () => 0,
  });
  let caught = null;
  try { await s.request(R([0, 4096]), { priority: "immediate" }); }
  catch (e) { caught = e; }
  ok(caught !== null && /boom/.test(caught.message), "the caller hears about it");
}

group("stats report what actually happened");
{
  const h = harness();
  await h.s.request(R([0, 4096]), { priority: "immediate" });
  const st = h.s.stats();
  ok(st.requests === 1, "counts requests");
  ok(st.bytesFetched === 4096, "counts bytes fetched");
  ok(st.knee > 0, "publishes the knee it is using");
  ok(st.heldBytes === 4096, "knows what it holds");
  ok(st.active === 0, "nothing left in flight");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
