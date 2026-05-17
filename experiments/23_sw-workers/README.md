# sw-workers

**Question:** [06](../06_grid-streaming-workers/README.md) found workers
*don't* help VP8 HW decoding (it's hardware-decode-bound). Does the
same hold for **software decoding**? Software decode is CPU-bound and
delivers output via callbacks; moving each SW decoder into its own
worker should free both CPU contention and main-thread callback queue.

And the headline: does workerised AV1-SW + main-thread VP9-HW recover
the cross-codec additivity that [20c](../20c_cross-codec-dual-pool/README.md)
lost (459 vs predicted 632)?

## Why

20c suggested two candidates for the shared bottleneck:
- Memory bandwidth (addressed by 20d)
- **Main-thread callback queue** (addressed here)

If main-thread saturation is the cause, then:
1. AV1-SW-4 in 4 workers should beat AV1-SW-4 on main thread (each
   worker's callbacks land on its own thread)
2. Cross-codec (VP9-HW main + AV1-SW workers) should recover full
   additivity (~632 fps on this device per 20c's per-pool baselines)

If memory bandwidth is the cause instead, workers won't help either.

This is also the lowest-cost architectural win available: if it works,
no extra storage, no extra codec management — just move SW decoders to
workers.

## Setup

Source: standard 1280×720 VP8 capture → transcode to VP9 (for HW pool)
and AV1 (for SW pool), matching 20c.

Five passes, all running 10s flat-out:

- **av1-sw-4 main** (baseline) — 4 AV1 SW decoders, all on main thread
- **av1-sw-4 workers** — 4 AV1 SW decoders, one per worker
- **vp9-hw-4 main** (baseline) — 4 VP9 HW decoders, main thread
- **cross-4+4 main** (baseline, = 20c's cross-4+4) — VP9 HW + AV1 SW
  all on main
- **cross-4+4 hw-main, sw-workers** (the headline) — VP9 HW on main,
  AV1 SW in 4 workers

## What's measured

Per pass:
- Aggregate fps
- Per-pool fps split
- Per-decoder fps (each worker reports its own count back)
- Errors per worker
- Worker spin-up cost (informational)

## What to look for

- **av1-sw-4 workers ≫ av1-sw-4 main** → main-thread output queue was
  capping SW decode
- **av1-sw-4 workers ≈ av1-sw-4 main** → SW is CPU-bound, not
  callback-queue-bound; workers don't help
- **cross-4+4 with workers ≈ predicted-additive (~600+ fps)** → main-
  thread contention was 20c's culprit; cross-codec dual-pool is back
  on the table
- **cross-4+4 with workers ≈ cross-4+4 main (~460 fps)** → bottleneck
  is memory bandwidth (corroborates whatever 20d shows)

## Caveats

- Worker postMessage of EncodedVideoChunk: chunks aren't natively
  transferable; the worker rebuilds them from raw ArrayBuffers. There's
  a one-time setup cost; the decode loop after that pays nothing.
- Decoded VideoFrames are *closed in the worker* — never crossing back
  to main. Real cells need ImageBitmap transfer for paint; that's
  outside this experiment's scope and probably a meaningful follow-up
  cost.
- Tests assume VideoDecoder is available in Worker scope (yes on
  Chrome ≥ 94)
- Each worker creates its own decoder — no cross-worker pooling
- Workers cost ~5-20ms to spin up; not in the run window, but be aware
  if the experiment ever pools and re-spawns mid-run

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
TIMEOUT_MS=180000 PORT=<port> experiments/harness/run.sh 23_sw-workers
```
