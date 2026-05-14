# raw-capability

**Question:** what are the device's raw video decode + GPU upload limits?

## Setup

Records a fresh VP8 clip from the device camera at two resolutions (same
`getUserMedia` + `MediaRecorder` path the app uses), demuxes it to
`EncodedVideoChunk`s, then runs four measurements:

- **M1 — concurrent decoder ceiling.** Allocate `VideoDecoder`s one at a
  time, each kept alive and fed one keyframe, until `configure()` throws,
  an error fires, or per-keyframe decode latency collapses (the silent
  software-fallback signature). Capped at `params.maxDecoders`.
- **M2 — reset/reconfigure cost.** Mean of reset → configure →
  decode-keyframe → flush, over `params.reconfigureIterations`.
- **M3 — single-decoder throughput.** Decode every chunk on one decoder;
  report decoded fps and `fps / 30` = realtime cells one decoder can feed.
- **M4 — `texImage2D` upload cost.** Mean ms to upload one decoded frame
  to a GL texture (`gl.finish()` forced), over `params.uploadIterations`.

Params live in the `params` block of `index.ts`. `result.json` is the
latest run.

## Verdict (2026-05-14 · Galaxy A15 · Android 10 · Chrome 148)

Resolution dominates everything. The headline run is **720p**
(`result.json`); the toy-resolution runs are kept only to show how
misleading low res was.

| | **720p** (current) | 320×240 (toy) |
|---|---|---|
| capture (actual) | 720×1280 / 480×640 | 240×320 / 132×176 |
| **M1 ceiling** | 16 ok; **64 OOM-crashed Chrome** | 32–64, no break |
| **M2 reconfigure** | **79 ms** mean (399 ms warmup) | ~6–8 ms |
| **M3** hi / lo | **2.9 / 4.7** cells per decoder | 14–49 cells |
| **M4** upload hi / lo | 1.20 / 1.35 ms | 0.1–0.9 ms |

**The "Android caps decoders at 2–4" premise is still falsified** — 16
concurrent `VideoDecoder`s ran fine at 720p. But the realistic-resolution
numbers are far more constrained than the toy ones implied:

- **M1** — 16 decoders fine; 64 at 720p *crashed the tab* (OOM). True
  720p ceiling is somewhere in 16–64, and it manifests as a **crash**,
  not a catchable error.
- **M3** — one decoder feeds only **~3–5 realtime cells** at 480–720p,
  not the 14–49 the toy resolutions suggested.
- **M2** — reconfigure is **~80 ms** at 720p (vs ~6 ms at toy res). Far
  too slow to switch streams per frame; time-slicing must be
  **GOP-batched**.
- **M4** — ~1.2 ms/upload. ~16 uploads/frame ≈ 19 ms — fits the 33 ms
  budget, but not with much headroom.

**Net:** streaming is still viable, but "unbounded N" at full resolution
is genuinely bounded — ballpark ~50–100 cells before you must drop
per-cell resolution or fall back to a composite. **Resolution is the
biggest lever.** The toy-res runs should not inform the design.

**Caveat:** M1 still only proves *instantiation* — each decoder decoded
one keyframe, not sustained concurrent decode. The **decoder-pools**
experiment (sustained N-decoder throughput) remains the decisive test.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
PORT=<port> experiments/harness/run.sh raw-capability
```
