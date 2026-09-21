# load-scheduler

Turns *"I want these bytes"* into *as few well-sized transfers as the link
actually justifies* — measured at runtime, never tuned by hand.

Nothing here knows about octrees, dots, cameras or viewers. It knows byte
ranges, elapsed times and priorities. Any HTTP client doing ranged reads has
this problem.

## Why it exists

A hand-picked chunk size is wrong on every link but the one it was picked on.
Measured on a local dev server: **26 ms of fixed overhead per request, 23 MB/s
of throughput.** So

```
one 4 KiB request     26 ms   0.7% of the time is transfer
one 512 KiB request   48 ms    46% of the time is transfer
```

Asking for 128× the bytes costs 1.8× the time. The knee — where transfer time
equals overhead, so you stop paying mostly for round trips — is

```
knee_bytes = overhead x throughput
```

which on that link is ~584 KiB, and on a phone on mobile data is a different
number entirely. Neither is knowable in advance, and both are measurable for
free from requests already being made.

## The contract

```js
const s = createScheduler({ fetchRange, concurrency: 4, maxWait: 40 });
await s.request([{ lo: 0, hi: 4096 }], { priority: "immediate" });
```

* `fetchRange(lo, hi)` — the only thing it needs from the outside. May return
  the bytes or a promise of them, and may throw; all three are handled. How
  they are fetched is not its business.
* `request(ranges, opts)` — resolves once every byte asked for has arrived,
  and **rejects** if a transfer fails. A failure rejects every outstanding
  request, since at this level a failed run cannot be told apart from an
  unrelated one.

### Two priorities, because bulking must not delay a new view

* `immediate` — dispatched now. A view that jumped somewhere new cannot wait
  for a bulk window to fill; the user is looking at nothing.
* `fill` — allowed to wait up to `maxWait` ms, or until enough bytes have
  accumulated to reach the knee. One block at the edge of an existing view can
  afford this; it is what makes the transfers efficient.

### What it measures

Only a transfer that had the link to itself is a sample: with others in
flight on the same pipe, wall time counts their bytes too. Once there is a
fit, a sample past 4x its prediction + 20 ms is a stall and is set aside;
four in a row means the link really changed, and they replace the window.
`stats()` reports `samplesFitted`, `samplesShared` and `samplesStalled`.

### `ordered` (prototype, off by default)

`createScheduler({ ordered: true })` and `request(ranges, { rank })` send runs
lowest rank first instead of in address order, and settle waiters lowest rank
first. For callers that need arrivals in their own order. Not settled.

### It never fetches the same bytes twice

Requested ranges are subtracted against what has **arrived** and what is
**in flight** before anything is planned, and a bridge is **never allowed to
cross** either. The HTTP pipe is the bottleneck, so re-reading bytes already
held is the most expensive possible mistake.

Subtracting first is not enough on its own, and an earlier version relied on
it: after subtraction, the holes between the remaining runs are frequently the
held bytes themselves, and a bridge sized to the knee (~560 KiB) spans them —
fetching them again. Only refusing the bridge prevents that.

## Layout

| file | what it does |
| --- | --- |
| `lib/estimate.js` | fits `elapsed = overhead + bytes/throughput`, reports the knee |
| `lib/intervals.js` | normalise, subtract, bridge, split — byte-range set algebra |
| `lib/plan.js` | wanted minus held minus in-flight, bridged to the knee, split to a cap |
| `lib/schedule.js` | priorities, in-flight tracking, concurrency, waiters |

`node --test` or `npm test`.
