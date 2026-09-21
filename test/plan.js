// node test/plan.js
import { planRuns, worthSending } from "../lib/plan.js";
import { createEstimator } from "../lib/estimate.js";

let pass = 0, fail = 0;
const eq = (got, want, what) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; return; }
  fail++; console.log(`  FAIL ${what}\n       got  ${a}\n       want ${b}`);
};
const ok = (c, what) => { c ? pass++ : (fail++, console.log(`  FAIL ${what}`)); };
const group = (n) => console.log("\n" + n);
const R = (...pairs) => pairs.map(([lo, hi]) => ({ lo, hi }));

group("nothing to do");
{
  const p = planRuns(R([0, 100]), { held: R([0, 100]) });
  eq(p.runs, [], "everything held means no runs");
  eq(p.needBytes, 0, "and nothing needed");
}
{
  const p = planRuns(R([0, 100]), { inFlight: R([0, 100]) });
  eq(p.runs, [], "everything already in flight means no runs");
}

group("held bytes are never re-requested");
{
  const p = planRuns(R([0, 16384]), { held: R([4096, 8192]), gap: 0 });
  eq(p.runs, R([0, 4096], [8192, 16384]), "the held middle is skipped");
  eq(p.needBytes, 12288, "only the missing bytes are counted as needed");
  eq(p.waste, 0, "with no bridging there is no waste");
}

group("in-flight bytes are never re-requested");
{
  // THE DEDUP THAT MATTERS MOST: two loaders naming overlapping regions in the
  // same frame must not each pay for the overlap.
  const p = planRuns(R([0, 8192]), { inFlight: R([2048, 6144]), gap: 0 });
  eq(p.runs, R([0, 2048], [6144, 8192]), "the in-flight middle is skipped");
}

group("subtraction happens BEFORE bridging");
{
  // If bridging ran first it would merge across the held block and then
  // subtract nothing, re-fetching bytes already in hand for no reason.
  const p = planRuns(R([0, 4096], [8192, 12288]), { held: R([4096, 8192]), gap: 0 });
  eq(p.runs, R([0, 4096], [8192, 12288]), "two runs, not one merged run");
  eq(p.waste, 0, "and nothing is paid for twice");
}

group("bridging trades bytes for round trips, and says how many");
{
  const p = planRuns(R([0, 4096], [8192, 12288]), { gap: 4096 });
  eq(p.runs, R([0, 12288]), "a gap at the limit is bridged");
  eq(p.needBytes, 8192, "needed is what was asked for");
  eq(p.fetchBytes, 12288, "fetched includes the bridge");
  eq(p.waste, 4096, "the difference is reported, not hidden");
}
{
  const p = planRuns(R([0, 4096], [8192, 12288]), { gap: 4095 });
  eq(p.runs.length, 2, "one byte short of the limit is not bridged");
}

group("runs are capped");
{
  const p = planRuns(R([0, 10000]), { maxRun: 4096 });
  eq(p.runs, R([0, 4096], [4096, 8192], [8192, 10000]), "split at the cap");
  eq(p.fetchBytes, 10000, "splitting changes no totals");
}

group("worthSending follows the measured knee");
{
  const e = createEstimator();
  ok(!worthSending(1, e), "a single byte is never worth a round trip");
  ok(worthSending(e.knee(), e), "exactly the knee is");
  ok(worthSending(e.knee() * 2, e), "and anything above it");
}

group("a bridge never spans held or in-flight bytes, whatever the gap");
{
  // THE REGRESSION. The ordering test above uses gap 0, so it could not see
  // this: the hole left by subtracting held bytes IS the held bytes, and a
  // bridge sized to the knee filled it -- fetching them a second time.
  const p = planRuns(R([0, 4096], [8192, 12288]), { held: R([4096, 8192]), gap: 4096 });
  eq(p.runs, R([0, 4096], [8192, 12288]), "held hole is not bridged even though it fits the gap");
  eq(p.waste, 0, "and nothing is paid for twice");
}
{
  const p = planRuns(R([0, 4096], [8192, 12288]), { inFlight: R([4096, 8192]), gap: 1 << 20 });
  eq(p.runs.length, 2, "an in-flight hole is not bridged at a huge gap either");
}
{
  // A hole that is only PARTLY held must not be bridged: any overlap is a refetch.
  const p = planRuns(R([0, 4096], [12288, 16384]), { held: R([6000, 7000]), gap: 1 << 20 });
  eq(p.runs.length, 2, "partly held hole is not bridged");
}
{
  // An ordinary hole nobody has is still bridged -- the fix must not kill the trade.
  const p = planRuns(R([0, 4096], [8192, 12288]), { held: R([100000, 104096]), gap: 4096 });
  eq(p.runs, R([0, 12288]), "an unheld hole is still bridged");
  eq(p.waste, 4096, "and its cost reported");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
