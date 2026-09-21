// node test/estimate.js
import { createEstimator } from "../lib/estimate.js";

let pass = 0, fail = 0;
const ok = (c, what) => { c ? pass++ : (fail++, console.log(`  FAIL ${what}`)); };
const near = (got, want, tol, what) => {
  if (Math.abs(got - want) <= tol) { pass++; return; }
  fail++; console.log(`  FAIL ${what}\n       got  ${got}\n       want ${want} +/- ${tol}`);
};
const group = (n) => console.log("\n" + n);

// A link that takes 25 ms to answer and then moves 1000 bytes per ms.
const OVERHEAD = 25, RATE = 1000;
const elapsed = (bytes) => OVERHEAD + bytes / RATE;

group("before anything is measured");
{
  const e = createEstimator();
  ok(!e.measured, "reports that it has not measured");
  ok(e.overheadMs > 0 && e.bytesPerMs > 0, "still answers, from defaults");
  ok(e.knee() > 0, "the knee is usable from the start");
}

group("it refuses a fit it cannot justify");
{
  const e = createEstimator();
  for (let i = 0; i < 20; i++) e.observe(4096, elapsed(4096));
  ok(!e.measured, "identical sizes give no fit -- any line explains them");
  const f = createEstimator();
  f.observe(1000, elapsed(1000));
  f.observe(100000, elapsed(100000));
  ok(!f.measured, "two samples is below the minimum");
}

group("it recovers a known link");
{
  const e = createEstimator();
  for (const b of [1000, 5000, 10000, 20000, 50000, 100000]) e.observe(b, elapsed(b));
  ok(e.measured, "fits once there are enough samples with spread");
  near(e.overheadMs, OVERHEAD, 0.5, "recovers the overhead");
  near(e.bytesPerMs, RATE, 20, "recovers the throughput");
  // The knee is where transfer time equals overhead: 25 ms x 1000 B/ms.
  near(e.knee(), OVERHEAD * RATE, 1000, "knee = overhead x throughput");
  near(e.predictMs(25000), 50, 1, "predicts a transfer at the knee as 2x overhead");
}

group("it rejects a fit the model does not describe");
{
  const e = createEstimator();
  // Bigger requests answering faster: a cache, not a link.
  for (const b of [1000, 5000, 10000, 20000, 50000, 100000]) e.observe(b, 200 - b / 1000);
  ok(!e.measured, "a negative slope is refused rather than published");
  ok(e.overheadMs > 0, "defaults still stand");
}

group("it forgets old samples");
{
  const e = createEstimator({ size: 8 });
  for (const b of [1000, 5000, 10000, 20000, 50000, 100000, 7000, 9000]) e.observe(b, elapsed(b));
  ok(e.samples() === 8, "keeps only the window");
  for (let i = 0; i < 8; i++) e.observe(1000 + i * 10000, 10 + (1000 + i * 10000) / 5000);
  near(e.bytesPerMs, 5000, 200, "tracks a link that got faster");
}

group("bad input is ignored, not fatal");
{
  const e = createEstimator();
  e.observe(0, 10); e.observe(-5, 10); e.observe(1000, -1);
  ok(e.samples() === 0, "zero, negative and impossible samples are dropped");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
