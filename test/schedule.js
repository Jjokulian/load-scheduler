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

const within = (p, ms, what) => Promise.race([
  p.then(() => "resolved", () => "rejected"),
  new Promise((r) => setTimeout(() => r(`HUNG (${what})`), ms)),
]);

group("held neighbours are not refetched through a bridge");
{
  // Default knee is ~575 KB, so without the fix this bridges straight across.
  const h = harness();
  h.s.seed(R([4096, 8192]));
  await h.s.request(R([0, 4096], [8192, 12288]), { priority: "immediate" });
  const overlaps = h.calls.filter(([lo, hi]) => lo < 8192 && hi > 4096);
  ok(overlaps.length === 0, `no transfer covers the seeded bytes (saw ${JSON.stringify(h.calls)})`);
}
{
  const h = harness({ manual: true });
  h.s.request(R([4096, 8192]), { priority: "immediate" });
  h.s.request(R([0, 4096], [8192, 12288]), { priority: "immediate" });
  const overlaps = h.calls.slice(1).filter(([lo, hi]) => lo < 8192 && hi > 4096);
  ok(overlaps.length === 0, "in-flight bytes are not put on the wire a second time");
  h.settleAll(); await tick();
}

group("fetchRange may throw or return a plain value without wedging anything");
{
  let first = true;
  const s = createScheduler({
    concurrency: 1, now: () => 0,
    fetchRange: () => { if (first) { first = false; throw new Error("sync boom"); } return "bytes"; },
  });
  const a = await within(s.request(R([0, 4096]), { priority: "immediate" }), 200, "throw");
  ok(a === "rejected", `a synchronous throw rejects the caller (got ${a})`);
  ok(s.stats().active === 0, "and releases its concurrency slot");
  const b = await within(s.request(R([8192, 12288]), { priority: "immediate" }), 200, "after throw");
  ok(b === "resolved", `the next request still completes (got ${b})`);
  ok(s.stats().inFlightBytes === 0, "and nothing is stranded in flight");
}

group("a fill batch waits for company once, not once per wave");
{
  // Five runs a megabyte apart, so none can be bridged, well under the knee,
  // at concurrency 2: three waves. Only the first may wait.
  const h = harness({ manual: true, concurrency: 2, maxWait: 40 });
  const want = [0, 1, 2, 3, 4].map((i) => [i * 1e6, i * 1e6 + 4096]);
  const p = h.s.request(R(...want), { priority: "fill" });
  ok(h.calls.length === 0 && h.timers.length === 1, "the batch waits for company first");
  h.fireTimers();
  ok(h.calls.length === 2, "the deadline sends the first wave, as many as fit");
  h.settleAll(); await tick();
  ok(h.timers.filter(Boolean).length === 0, "no second deadline is armed for what was already queued");
  ok(h.calls.length === 4, `the second wave follows as room frees (saw ${h.calls.length} transfers)`);
  h.settleAll(); await tick();
  ok(h.calls.length === 5, "and the third");
  h.settleAll(); await p;
  // The window re-opens for a NEW batch once the old one has drained.
  h.s.request(R([9e6, 9e6 + 4096]), { priority: "fill" });
  ok(h.calls.length === 5 && h.timers.filter(Boolean).length === 1, "a later fill request waits for company again");
}
{
  // A knee-sized batch goes at once; its remainder must not then wait.
  const h = harness({ manual: true, concurrency: 1, maxWait: 40 });
  const knee = h.s.estimator.knee();
  const p = h.s.request(R([0, knee], [5e6, 5e6 + 4096]), { priority: "fill" });
  ok(h.calls.length === 1, "past the knee the batch goes without waiting");
  h.settleAll(); await tick();
  ok(h.calls.length === 2 && h.timers.filter(Boolean).length === 0, "and the small remainder follows without a deadline");
  h.settleAll(); await p;
}

group("only a transfer that had the link to itself is a sample");
{
  // A fake clock and a link whose elapsed is 25 ms + 1 B/us.
  let t = 0;
  const pend = [];
  const s = createScheduler({ concurrency: 4, now: () => t,
    fetchRange: (lo, hi) => new Promise((res) => pend.push({ res, bytes: hi - lo })) });
  const settle = async (ms) => { t += ms; pend.shift().res(); await tick(); };
  // Four at once on one pipe: each finishes behind the others' bytes.
  const four = s.request(R([0, 1000], [1e7, 1e7 + 8000], [2e7, 2e7 + 16000], [3e7, 3e7 + 64000]), { priority: "immediate" });
  ok(pend.length === 4, "four transfers share the link");
  for (const b of [1000, 8000, 16000, 64000]) await settle(25 + b / 1000);
  await four;
  ok(s.estimator.samples() === 0 && s.stats().samplesShared === 4, `none of the four is a sample (${s.estimator.samples()} fitted)`);
  // One at a time: every one is.
  for (const [i, b] of [1000, 4000, 16000, 64000, 2000, 32000].entries()) {
    const p = s.request(R([5e7 + i * 1e7, 5e7 + i * 1e7 + b]), { priority: "immediate" });
    await settle(25 + b / 1000); await p;
  }
  ok(s.estimator.samples() === 6 && s.stats().samplesFitted === 6, "six lone transfers are six samples");
  ok(s.estimator.measured && Math.abs(s.estimator.overheadMs - 25) < 0.5, `and they fit the link (${s.estimator.overheadMs.toFixed(2)} ms)`);
}

group("a stall held on the link does not poison the scheduler's fit");
{
  let t = 0;
  const pend = [];
  const s = createScheduler({ concurrency: 1, now: () => t,
    fetchRange: (lo, hi) => new Promise((res) => pend.push({ res })) });
  const one = async (i, b, ms) => {
    const p = s.request(R([i * 1e7, i * 1e7 + b]), { priority: "immediate" });
    t += ms; pend.shift().res(); await tick(); await p;
  };
  const sizes = [1000, 4000, 16000, 64000, 2000, 32000, 8000, 128000];
  for (const [i, b] of sizes.entries()) await one(i, b, 25 + b / 1000);
  await one(20, 4096, 2000);                     // held 2 s by a stall
  for (const [i, b] of sizes.entries()) await one(30 + i, b, 25 + b / 1000);
  const e = s.estimator;
  ok(e.measured, "still measured after the stall");
  ok(Math.abs(e.overheadMs - 25) < 0.5 && Math.abs(e.bytesPerMs - 1000) < 20,
     `overhead ${e.overheadMs.toFixed(2)} ms, ${e.bytesPerMs.toFixed(0)} B/ms: the stall is not in it`);
  ok(s.stats().samplesStalled === 1, "and the stalled sample is counted, not hidden");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
