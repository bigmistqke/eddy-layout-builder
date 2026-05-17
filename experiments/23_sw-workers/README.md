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

## Verdict

**Workers don't help — at 720p.**

| pass | aggregate | vp9-hw | av1-sw |
|---|---|---|---|
| av1-sw-4 main | 448 | — | 448 |
| av1-sw-4 workers | 443 | — | 443 |
| vp9-hw-4 main | 177 | 177 | — |
| cross-4+4 main | **469** | 167 | 302 |
| cross-4+4 hw-main + sw-workers | **472** | 166 | 306 |

Both predictions fail:
- AV1-SW solo is identical main vs workers (448 vs 443)
- Cross-codec additivity does not recover (469 vs 472) — the ~30% deficit vs predicted (~625) persists when SW is workerised

The bottleneck is **not** main-thread callback saturation at 720p. Best remaining guess: Chrome's GPU/codec service IPC. Workers don't bypass it because they all talk to the same GPU process. Plausible specific causes: output frame allocation, GPU↔CPU memory copy for SW-decoded frames, or a shared decode-task queue in the renderer.

**Important caveat:** at 720p the SW pool delivers ~450 callbacks/sec — not enough to saturate the main thread. [20d](../20d_resolution-codec-pool/README.md)'s "lower res hurts more" finding was at 360p, where the SW pool produces ~1690 callbacks/sec. That hypothesis isn't disproven yet — just untested at the resolution where it would actually matter. A 23b sweep across resolutions (or 20d + workers) would close it.

## Why workers don't help — the Chrome architecture

Intuition says "SW decode = CPU work, more worker threads = more parallelism." But on Chrome (~95+), **`VideoDecoder.decode()` doesn't actually run in the JavaScript renderer at all** — it IPCs the decode task to the **GPU process**, which is where both HW and SW decode execute. The "GPU process" name is misleading: it manages GPU resources but also runs CPU codecs like dav1d.

So when you put 4 decoders in 4 workers, all 4 still funnel into the same GPU-process decode pool. The renderer threads (main or workers) only handle IPC plumbing and the output callback fan-out, which is cheap.

The actual parallelism is determined by:
1. How many threads the GPU process spawns for decode tasks (tied to core count)
2. Whether the codec library is internally threaded (dav1d is — that's why one AV1-SW decoder at 360p hits 420+ fps, far more than one core could do alone)

Spawning 4 decoders already saturates the GPU process's decode capacity on this device. Adding workers in front doesn't unlock anything because the bottleneck isn't in the renderer.

This also reframes [20c](../20c_cross-codec-dual-pool/README.md)'s cross-codec contention as **GPU-process contention**: VP9-HW and AV1-SW both run in the GPU process, share its IPC queue back to the renderer, and may share frame allocators. That model fits 20c/20d better than either "memory bandwidth" or "renderer main-thread saturation."

Where workers *would* help on this stack is anywhere the cost lives on the renderer side: `copyTo()` into a CPU buffer, atlas builds, JS render math. The decode loop itself is just IPC + callbacks.

## Note for eddy implementation

- For **aggregate throughput**, workers vs main is a wash on this device (at 720p; possibly different at lower res)
- BUT workers free the main thread for rAF / capture / WebGL upload / atlas builds. Even at equal aggregate fps, the **latency picture changes** meaningfully under a real render loop, where main thread already has other work
- The "main thread is fine for decode" data was collected with an idle main thread. In a contended render loop, workers might still pull ahead even at 720p
- An end-to-end render-loop experiment would be the right place to measure this — decoder location's effect on jank/frame-pace under realistic main-thread load

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
