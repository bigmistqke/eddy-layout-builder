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

## Verdict

_Pending first device run._

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
PORT=<port> experiments/harness/run.sh decoder-pools
```
