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
on a budget device.

- **M1 = 32, `max-reached`** — 32 concurrent `VideoDecoder`s allocated,
  zero errors, no throughput collapse. We hit the probe's cap, not the
  device's; true ceiling still unknown.
- **M2 ≈ 6.3 ms** mean (43 ms warmup, then ~4–6 ms). Time-slicing one
  decoder across streams is cheap.
- **M3** — hi-res 240×320: 549 fps → 18.3 realtime cells/decoder;
  lo-res 132×176: 1466 fps → 48.9 cells/decoder.
- **M4** — 0.21 ms hi-res / 0.075 ms lo-res. Negligible; even 50
  uploads/frame fits the 33 ms budget.

Per the design doc's decision rule (`M1 ≥ ~16 AND M4 cheap → streaming
viable, revisit family`), this **reopens the architecture question in
favour of streaming**.

**Caveat:** M1 only proves *instantiation* — each decoder decoded one
keyframe, not sustained concurrent decode. The **decoder-pools**
experiment must confirm sustained N-decoder throughput before the
composite is fully ruled out.

**Open:** the `maxDecoders=128` run hung after recording (device
flakiness, not a measured limit) — re-run to find the true M1 ceiling.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
PORT=<port> experiments/harness/run.sh raw-capability
```
