// node test/intervals.js
import { normalise, subtract, bridge, split, total } from "../lib/intervals.js";

let pass = 0, fail = 0;
const eq = (got, want, what) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; return; }
  fail++; console.log(`  FAIL ${what}\n       got  ${a}\n       want ${b}`);
};
const group = (n) => console.log("\n" + n);
const R = (...pairs) => pairs.map(([lo, hi]) => ({ lo, hi }));

group("normalise");
eq(normalise([]), [], "empty stays empty");
eq(normalise(R([10, 20], [0, 5])), R([0, 5], [10, 20]), "sorts");
eq(normalise(R([0, 10], [5, 15])), R([0, 15]), "merges overlapping");
eq(normalise(R([0, 10], [10, 20])), R([0, 20]), "merges touching");
eq(normalise(R([0, 10], [20, 30])), R([0, 10], [20, 30]), "leaves a real gap");
eq(normalise(R([5, 5], [0, 10])), R([0, 10]), "drops zero-length");
eq(normalise(R([0, 30], [10, 20])), R([0, 30]), "swallows a contained run");

group("subtract");
eq(subtract(R([0, 100]), []), R([0, 100]), "nothing to remove");
eq(subtract([], R([0, 10])), [], "nothing to remove from");
eq(subtract(R([0, 100]), R([0, 100])), [], "exact removal empties");
eq(subtract(R([0, 100]), R([10, 20])), R([0, 10], [20, 100]), "punches one hole");
eq(subtract(R([0, 100]), R([10, 20], [30, 40])),
   R([0, 10], [20, 30], [40, 100]), "punches two holes");
eq(subtract(R([0, 50], [60, 100]), R([40, 70])),
   R([0, 40], [70, 100]), "one removal spanning two runs");
eq(subtract(R([0, 10]), R([0, 4], [4, 10])), [], "adjacent removals cover it");
eq(subtract(R([0, 100]), R([200, 300])), R([0, 100]), "disjoint removal is a no-op");
eq(subtract(R([50, 60]), R([0, 100])), [], "fully contained is removed");
// The scheduler leans on this: a later run re-entering an earlier removal.
eq(subtract(R([0, 10], [20, 30], [40, 50]), R([5, 45])),
   R([0, 5], [45, 50]), "removal spanning three runs");

group("bridge");
eq(bridge(R([0, 10], [20, 30]), 0), R([0, 10], [20, 30]), "gap 0 bridges nothing");
eq(bridge(R([0, 10], [20, 30]), 10), R([0, 30]), "gap equal to the hole bridges");
eq(bridge(R([0, 10], [20, 30]), 9), R([0, 10], [20, 30]), "one short does not");
eq(bridge(R([0, 10], [20, 30], [100, 110]), 10),
   R([0, 30], [100, 110]), "bridges near, leaves far");
eq(total(bridge(R([0, 10], [20, 30]), 10)), 30, "bridged run includes the hole");

group("split");
eq(split(R([0, 100]), 0), R([0, 100]), "cap 0 is no cap");
eq(split(R([0, 100]), 100), R([0, 100]), "exactly the cap is one run");
eq(split(R([0, 100]), 40), R([0, 40], [40, 80], [80, 100]), "splits with a remainder");
eq(split(R([0, 10], [50, 60]), 4),
   R([0, 4], [4, 8], [8, 10], [50, 54], [54, 58], [58, 60]), "splits each run");
eq(total(split(R([0, 100]), 7)), 100, "splitting preserves total");

group("bridge with avoid: linear form equals the per-hole form");
{
  // The reference: test each hole against everything blocked, as the first
  // version did. Correct, and quadratic.
  const reference = (list, gap, avoid) => {
    const xs = normalise(list), blocked = normalise(avoid);
    if (xs.length < 2 || !(gap > 0)) return xs;
    const out = [xs[0]];
    for (let i = 1; i < xs.length; i++) {
      const last = out[out.length - 1], hole = { lo: last.hi, hi: xs[i].lo };
      const clear = total(subtract([hole], blocked)) === hole.hi - hole.lo;
      if (hole.hi - hole.lo <= gap && clear) last.hi = Math.max(last.hi, xs[i].hi);
      else out.push({ ...xs[i] });
    }
    return out;
  };
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const rand = (k, span) => Array.from({ length: k }, () => {
    const lo = rnd(span); return { lo, hi: lo + 1 + rnd(40) };
  });
  let mismatches = 0;
  for (let t = 0; t < 3000; t++) {
    const list = rand(1 + rnd(12), 600), avoid = rand(rnd(10), 600), gap = rnd(80);
    if (JSON.stringify(bridge(list, gap, avoid)) !== JSON.stringify(reference(list, gap, avoid))) mismatches++;
  }
  eq(mismatches, 0, "3,000 random cases agree with the per-hole reference");
  eq(bridge(R([0, 10], [20, 30]), 10, R([12, 13])), R([0, 10], [20, 30]), "a blocked byte inside the hole stops the bridge");
  eq(bridge(R([0, 10], [20, 30]), 10, R([10, 12])), R([0, 10], [20, 30]), "blocked at the hole's start");
  eq(bridge(R([0, 10], [20, 30]), 10, R([18, 20])), R([0, 10], [20, 30]), "blocked at the hole's end");
  eq(bridge(R([0, 10], [20, 30]), 10, R([5, 10], [30, 35])), R([0, 30]), "blocked only outside the hole does not");
}

group("total");
eq(total([]), 0, "empty is zero");
eq(total(R([0, 10], [20, 25])), 15, "sums lengths");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
