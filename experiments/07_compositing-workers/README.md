# compositing-workers

**Question:** can the composite pipeline — atlas **build** *and* atlas
**decode** — run entirely off the main thread?

## Why

[05_compositing-full-video](../05_compositing-full-video/README.md)
showed the composite wins on throughput, but the atlas **build** takes
~9–13 s. On the main thread that would freeze the UI for that whole
window — unacceptable in a live jam tool.

[06_grid-streaming-workers](../06_grid-streaming-workers/README.md)
already showed Workers don't change decode *throughput* (it's
hardware-bound). So this is **not** a speed experiment — it's a
**feasibility check**: run the whole composite pipeline inside a Worker
and confirm it (a) works and (b) produces the same numbers as 05. If so,
the real app can rebuild atlases in the background with its main thread
free for rendering.

## Setup

Identical grids to 05 (4, 9, 16, 25) at viewport-res atlas. The only
difference: `composite-worker.ts` runs `harness/composite.ts` (build) +
the decode loop inside a Worker; the main thread only records the source
and posts it in. Reports per-grid `compositeMs`, `fps`, `realtimeOk` —
directly comparable to 05.

**Read it as:** numbers ≈ 05 → the composite pipeline is worker-safe,
and the build can be backgrounded. Numbers diverge or it errors → some
part of the pipeline (`OffscreenCanvas`, `VideoEncoder`, `VideoDecoder`)
misbehaves in a Worker on this device.

## Verdict

_Pending first device run._

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
PORT=<port> experiments/harness/run.sh 07_compositing-workers
```
