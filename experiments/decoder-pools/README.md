# decoder-pools

**Question:** is the decoder pool actually dead? — i.e. can a pool of K
`VideoDecoder`s sustain *continuous concurrent* decode, each keeping up
with ~30 fps realtime, at realistic resolution?

## Why

The original design declared the live decoder pool "dead" — but that
rested on the (unmeasured, now falsified) "Android caps decoders at 2–4"
claim. [raw-capability](../raw-capability/README.md) showed the A15
*instantiates* 16+ decoders fine — but each only decoded **one
keyframe**. That doesn't prove they can all decode *continuously at the
same time*. This experiment closes that gap.

## Setup

Records one clip at `params.resolution`, then spins up `params.poolSize`
`VideoDecoder`s. Each loops the clip (reset → reconfigure → re-feed from
the keyframe) flat-out for `params.runSeconds` of wall-clock, with a
`maxQueue` backpressure cap so a slow decoder reveals its real
throughput instead of buffering unboundedly. Reports each decoder's
sustained fps, the min across the pool, the aggregate, and whether the
slowest held `realtimeFps` (28).

**Interpretation:** if every decoder holds ~30 fps, the pool is alive for
N = K cells. To vary, edit `params` in `index.ts` and commit. Time-slicing
one decoder across N > K cells (GOP-batched, given raw-capability's ~80 ms
reconfigure cost at 720p) is a later experiment.

## Verdict (2026-05-14 · Galaxy A15 · Android 10 · Chrome 148)

**The pool is not dead — but concurrency buys far less than its count
suggests.** K=8 at 720p (`result.json`):

- 8 decoders running at once each sustained only **~17 fps** (min 16.8,
  max 20.5) — **none hit realtime 30 fps**.
- Aggregate **141 fps**. Compare raw-capability's **1 decoder @ 720p =
  85 fps**: 8× the decoders → only ~1.66× the throughput. They contend
  for shared hardware decode bandwidth.

**Implication:** the binding limit is *aggregate* 720p decode capacity
(~140 fps on this device ≈ **~4–5 realtime streams**), not decoder
*count*. Spreading work across more decoders just slices the same pie
thinner. Two takeaways for the architecture:

1. Per-stream overhead is heavy — consolidating into **fewer, larger
   decodes** (the composite atlas: one decode regardless of N) genuinely
   helps, for a reason unrelated to the (falsified) decoder-count wall.
2. **Resolution is still the lever.** ~4–5 streams is the 720p budget;
   smaller per-cell resolution buys proportionally more. Streaming many
   cells means streaming them *small*.

**Caveats:** this is K=8 / N=8 — one decoder per cell, no time-slicing
(N > K would be worse, not better). Single run, 720p only — sweep
`poolSize` and `resolution`, and repeat (raw-capability showed 2–3×
run-to-run variance).

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
PORT=<port> experiments/harness/run.sh decoder-pools
```
