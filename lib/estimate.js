// WHAT THE LINK COSTS, measured from the requests already being made.
//
//   elapsed = overhead + bytes / throughput
//
// Two unknowns, so a straight least-squares fit over recent samples gives both
// -- provided the samples differ in size. They usually do, because a mix of
// immediate single-block reads and bulked fill reads is exactly what a viewer
// produces. When they do not differ enough, the fit is refused and the
// defaults stand, rather than reporting a slope derived from noise.
//
// The knee -- where transfer time equals overhead, so you stop paying mostly
// for round trips -- falls straight out:
//
//   knee = overhead x throughput = intercept / slope

const DEFAULTS = {
  size: 32,              // samples kept
  overheadMs: 26,        // until measured -- the dev server's figure
  bytesPerMs: 23000,     // ~23 MB/s, until measured
  minSamples: 6,
  minSpread: 4,          // largest sample must be 4x the smallest to fit
};

export function createEstimator(opts = {}) {
  const P = { ...DEFAULTS, ...opts };
  const xs = [], ys = [];
  let fit = null;

  function refit() {
    fit = null;
    const n = xs.length;
    if (n < P.minSamples) return;
    let min = Infinity, max = -Infinity;
    for (const x of xs) { if (x < min) min = x; if (x > max) max = x; }
    // WITHOUT SPREAD THE FIT IS MEANINGLESS. All-same-size samples give a
    // vertical line: any (overhead, throughput) pair explains them equally.
    if (!(min > 0) || max < min * P.minSpread) return;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxy += xs[i] * ys[i]; sxx += xs[i] * xs[i]; }
    const denom = n * sxx - sx * sx;
    if (!(Math.abs(denom) > 1e-9)) return;
    const slope = (n * sxy - sx * sy) / denom;        // ms per byte
    const intercept = (sy - slope * sx) / n;          // ms
    // A negative slope or intercept means the link did something the model does
    // not describe (a cache hit, a stall). Keep the defaults rather than
    // publishing a number that will size every future transfer wrongly.
    if (!(slope > 0) || !(intercept >= 0)) return;
    fit = { overheadMs: intercept, bytesPerMs: 1 / slope };
  }

  return {
    // One completed transfer. `bytes` is what came back, `ms` is wall clock.
    observe(bytes, ms) {
      if (!(bytes > 0) || !(ms >= 0)) return;
      xs.push(bytes); ys.push(ms);
      if (xs.length > P.size) { xs.shift(); ys.shift(); }
      refit();
    },
    get measured() { return fit !== null; },
    get overheadMs() { return fit ? fit.overheadMs : P.overheadMs; },
    get bytesPerMs() { return fit ? fit.bytesPerMs : P.bytesPerMs; },

    // Bytes at which transfer time equals overhead. Sets BOTH the bulk size
    // and the bridge gap -- they are the same decision, asked twice.
    knee() { return Math.max(1, Math.round(this.overheadMs * this.bytesPerMs)); },

    // How long a transfer of this size should take, for deciding whether a
    // queued run still fits inside a latency budget.
    predictMs(bytes) { return this.overheadMs + bytes / this.bytesPerMs; },

    samples() { return xs.length; },
    reset() { xs.length = 0; ys.length = 0; fit = null; },
  };
}
