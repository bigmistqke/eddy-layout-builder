# build-cost

**Question:** how does atlas build time scale with clip length — and is
the build-rate constant enough to plan a chunked/pipelined rebuild
around?

## Why

05/07 measured ~10–15 s to composite a **6-second** clip. The build is
per-frame work (decode → draw → re-encode every frame), so it should
scale linearly — meaning a 3–5 min song's composite takes **~6–10 min**
to build. That inverts the hybrid's "build ≪ take" assumption.

The single number that matters is the **slope**: build-seconds per
second-of-content. If it's a flat ~2× across clip lengths, the rebuild
cost is fully predictable and a chunked/pipelined strategy can be sized
against it. If it's super-linear, even chunking won't save it.

## Setup

Records clips of several lengths (`durations` — 4, 8, 16 s), composites
each into the same fixed-N atlas (N=16; atlas frame size is constant so
N shouldn't matter), and reports `compositeMs` and `buildRateVsRealtime`
(build-seconds ÷ content-seconds) for each.

(Required bumping `harness/input.ts`'s `MAX_CHUNKS` 150 → 600 so longer
clips aren't truncated.)

**Read it as:** a flat `buildRateVsRealtime` across durations → linear,
slope pinned, chunking is plannable. Rising ratio → super-linear, worse
than feared.

## Verdict

_Pending first device run._

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
PORT=<port> experiments/harness/run.sh 08_build-cost
```
