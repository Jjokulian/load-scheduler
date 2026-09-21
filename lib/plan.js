// WANTED -> RUNS. Pure, synchronous, and the only place the knee is applied.
//
// Order matters and is not negotiable:
//
//   1. subtract what has arrived      -- never pay for bytes already held
//   2. subtract what is in flight     -- never pay for bytes already asked for
//   3. bridge gaps up to the knee     -- trade wasted bytes for round trips,
//                                        but never across held or in-flight
//                                        bytes
//   4. split runs above the cap       -- no single run monopolises the link
//
// Ordering alone does not keep held bytes off the wire. After step 1 the holes
// between the remaining runs are frequently the held bytes themselves, and a
// bridge sized to the knee spans any of them up to ~560 KiB. So the bridge is
// told what it must not cross. Bridged bytes are only ever bytes nobody has.

import { subtract, bridge, split, total, normalise } from "./intervals.js";

export function planRuns(wanted, { held = [], inFlight = [], gap = 0, maxRun = 0 } = {}) {
  const need = subtract(subtract(wanted, held), inFlight);
  if (!need.length) return { runs: [], needBytes: 0, fetchBytes: 0, waste: 0 };
  const avoid = normalise([...held, ...inFlight]);
  const runs = split(bridge(need, gap, avoid), maxRun);
  const needBytes = total(need), fetchBytes = total(runs);
  return { runs, needBytes, fetchBytes, waste: fetchBytes - needBytes };
}

// Is this batch worth sending yet, or should it wait for more to accumulate?
// Below the knee a transfer is mostly round trip, so waiting is usually right
// -- but only up to a deadline, which the scheduler enforces, not this.
export function worthSending(bytes, estimator) {
  return bytes >= estimator.knee();
}
