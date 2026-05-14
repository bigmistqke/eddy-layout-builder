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

The original design's load-bearing premise — **"Android caps concurrent
decoders at 2–4, therefore a composite is mandatory"** — is **falsified**
on a budget device. Two runs:

| | run @ maxDecoders=64 (`result.json`) | earlier run @ 32 |
|---|---|---|
| **M1 ceiling** | 64 — `max-reached` | 32 — `max-reached` |
| **M2 reconfigure** | 8.1 ms mean | 6.3 ms mean |
| **M3** hi-res / lo-res | 410 / 581 fps | 549 / 1466 fps |
| **M4** hi-res / lo-res | 0.86 / 0.10 ms | 0.21 / 0.075 ms |

- **M1** hit the probe cap *both times* with zero errors / no throughput
  collapse — the device's true ceiling is **> 64**, still unmeasured.
- **M2** ~6–8 ms (after a ~50 ms warmup). Time-slicing one decoder
  across streams is cheap.
- **M3 / M4 swing 2–3× between runs** — thermal throttling, memory
  pressure (a 450-tab Brave was resident), and/or decoder-cleanup lag.
  Single runs are not trustworthy; repeat and compare `result.json`s.

Per the design doc's decision rule (`M1 ≥ ~16 AND M4 cheap → streaming
viable, revisit family`), this **reopens the architecture question in
favour of streaming**.

**Caveat:** M1 only proves *instantiation* — each decoder decoded one
keyframe, not sustained concurrent decode. The **decoder-pools**
experiment must confirm sustained N-decoder throughput before the
composite is fully ruled out.

**Caveat:** the runs above used unrealistically low capture resolutions
(320×240 / 160×120 — actually 240×320 / 132×176). M3/M4, and possibly
M1's memory ceiling, depend heavily on resolution. Re-run at realistic
camera resolutions (≥720p) before trusting these numbers.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
PORT=<port> experiments/harness/run.sh raw-capability
```
