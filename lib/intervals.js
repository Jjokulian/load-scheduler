// BYTE-RANGE SET ALGEBRA. Half-open [lo, hi). Everything else in this repo is
// built on these four, so they are kept dull and total: no throwing, empty in
// means empty out, and the result is always normalised.

// Sorted, non-overlapping, touching runs merged. Zero-length ranges dropped.
export function normalise(list) {
  const xs = [];
  for (const r of list) if (r && r.hi > r.lo) xs.push({ lo: r.lo, hi: r.hi });
  if (!xs.length) return [];
  xs.sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  const out = [xs[0]];
  for (let i = 1; i < xs.length; i++) {
    const last = out[out.length - 1], r = xs[i];
    if (r.lo <= last.hi) last.hi = Math.max(last.hi, r.hi);
    else out.push({ lo: r.lo, hi: r.hi });
  }
  return out;
}

// a minus b. THE MOST IMPORTANT FUNCTION HERE: it is what stops the same bytes
// being fetched twice, and bridging makes that easy to do by accident.
export function subtract(a, b) {
  const A = normalise(a), B = normalise(b);
  if (!B.length) return A;
  const out = [];
  let j = 0;
  for (const r of A) {
    let lo = r.lo;
    while (j > 0 && B[j - 1].hi > lo) j--;          // rewind; A runs may re-enter B
    while (j < B.length && B[j].hi <= lo) j++;
    let k = j;
    while (k < B.length && B[k].lo < r.hi) {
      if (B[k].lo > lo) out.push({ lo, hi: Math.min(B[k].lo, r.hi) });
      lo = Math.max(lo, B[k].hi);
      if (lo >= r.hi) break;
      k++;
    }
    if (lo < r.hi) out.push({ lo, hi: r.hi });
  }
  return out;
}

// Merge runs separated by a gap of at most `gap` bytes. The bridged bytes are
// fetched and thrown away; that is the trade this whole repo exists to size.
export function bridge(list, gap) {
  const xs = normalise(list);
  if (xs.length < 2 || !(gap > 0)) return xs;
  const out = [xs[0]];
  for (let i = 1; i < xs.length; i++) {
    const last = out[out.length - 1];
    if (xs[i].lo - last.hi <= gap) last.hi = Math.max(last.hi, xs[i].hi);
    else out.push({ ...xs[i] });
  }
  return out;
}

// Break runs longer than `max`, so one enormous run cannot monopolise the link
// and stall everything queued behind it.
export function split(list, max) {
  if (!(max > 0)) return normalise(list);
  const out = [];
  for (const r of normalise(list)) {
    for (let lo = r.lo; lo < r.hi; lo += max) {
      out.push({ lo, hi: Math.min(lo + max, r.hi) });
    }
  }
  return out;
}

export const total = (list) => list.reduce((n, r) => n + (r.hi - r.lo), 0);
