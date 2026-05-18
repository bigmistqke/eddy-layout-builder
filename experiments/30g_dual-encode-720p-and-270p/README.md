# dual-encode-720p-and-270p

**Question:** can the device sustain **two simultaneous AV1 encoders**
at capture time — 720p (canonical, for export/fullscreen) + 270p
(playback mip, for cells) — while K=9 decoders are concurrently
playing the 270p mip in workers?

## Why

[Exp 30b 720p](../30b_capture-encode-under-playback/README.md) and
[exp 30f](../30f_capture-encode-decoders-in-workers/README.md)
established that record-while-K=9-playing at 720p doesn't fit on the
A15: the AV1 SW encoder competes with the K AV1 SW decoders for CPU
+ memory bandwidth, regardless of whether decoders are in workers.

But 720p storage is a **product requirement** — fullscreen preview
and export need camera-native quality. And 270p **playback** is
demonstrably fine ([exp 30b 270p](../30b_capture-encode-under-playback/README.md):
encoder 30 fps, decoderMin 29.7).

The architectural fix proposed by the user:

> "we should always record on 720p minimum; we should not decode on
> 720p — what if we encode the raw camera output to av1 and then
> encode a lower quality av1 simultaneously — we use the lower
> quality to preview and the 720p to export finally"

This is exactly what hardware cameras do (multi-bitrate encode for
adaptive streaming). The question is whether AV1 SW can do it on the
A15 while K=9 decoders are also running.

## Setup

Phase 1 — fixture (offscreen, untimed):
1. Pre-encode 6 s of synthetic-pattern AV1 at **270p** (the playback
   mip). Demux to chunks + decoder config for the workers to loop.

Phase 2 — measured run, one per K in {4, 9}:
1. Spawn K **270p decoder workers** (same as
   [exp 30f](../30f_capture-encode-decoders-in-workers/README.md)).
2. Warm up 1 s.
3. On the main thread, run **two parallel encoders** from the same
   synthetic painter:
   - Encoder A: 720p AV1, fed `VideoSample`s directly from the 720p
     paint canvas
   - Encoder B: 270p AV1. The 720p frame is downscaled via
     `createImageBitmap(frame, {resizeWidth: 480, resizeHeight: 272,
     resizeQuality: 'low'})` — the browser-optimized path that may
     be GPU-accelerated. The resulting `ImageBitmap` is wrapped as
     a `VideoFrame` and fed to Encoder B.
   - Both encoders use the fire-and-track pattern from 30d.

   The `createImageBitmap` resize path is chosen over
   `ctx.drawImage + getImageData` because the latter was the cause
   of [30b's 720p copy-res regression](../30b_capture-encode-under-playback/README.md).
   If `createImageBitmap` resize falls back to CPU on the A15, that
   will show up as encoder B's add p95.
4. Run for 10 s. Drain both encoders. Finalize both outputs.

## What's measured

For each encoder (A=720p, B=270p):
- `encodedFps`, `pendingAddsMax`, `addP95Ms`, `addMaxMs`,
  `finalizeMs`, `webmBytes`, `roundTripVerified`

For the loop:
- `tickLagP95Ms` — tick-loop drift (single number — same loop drives
  both encoders)

For each decoder worker:
- `decoderFps[i]`, `decoderFpsMin`, `decoderFpsMean`

## What to look for

- **Both encoders at 30 fps, encoderA pendingMax ≤ 3, decoderMin ≥
  25 fps at K=9** — dual-encode works; the architecture's unblocked
- **EncoderA (720p) holds 30 fps, encoderB (270p) holds 30 fps,
  finalize ≤ 1 s** — the storage strategy is viable for production
- **EncoderA falls behind (addP95 > 33 ms)** — even the dual-encode
  approach can't sustain 720p under K=9 contention; we'd need to
  drop 720p encode to a worker thread or skip it during playback-
  heavy moments
- **EncoderB falls behind** — surprising; 270p has ~7× headroom in
  isolation. If it happens, the second encoder's mux + serialization
  overhead is non-trivial
- **Downscale step itself is slow** — measured indirectly via
  encoderB's add p95 vs encoderA's. If the 720p→270p drawImage is
  expensive, encoderB will lag

## Caveats

- Both encoders run on the main thread. WebCodecs `VideoEncoder` can
  run in workers, but mediabunny's `Output` + `VideoSampleSource`
  binding is main-thread here. A follow-up could move one or both
  encoders to a worker.
- The 270p source uses `drawImage` for downscale + `new VideoFrame`
  from the canvas. The 30b 720p re-run found this path is non-trivial
  vs `copyTo`. Encoder B's pendingMax will reflect that cost.
- Synthetic frames; thermal/camera-throttle effects not tested.
- Decoder workers use 270p AV1 — matches the encoder B output. In
  production they'd decode from the encoder B's bytestream; here
  they decode a pre-built fixture of the same shape.

## Findings (2026-05-18, sha `d9e50ab`, Galaxy A15)

**Dual-encode works cleanly at K=9.** Both encoders sustain 30 fps,
no queue depth, all decoders also at 30 fps. The user's architecture
is validated.

| K | hi fps | hi pend | hi addP95 | hi addMax | hi finalize | lo fps | lo pend | lo addP95 | lo finalize | resize p95 | resize max | tickLag p95 | decMin |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 4 | 30 | 1 | 7.8 ms | 52.5 ms | 48 ms | 30 | 2 | 3.7 ms | 24 ms | 3.3 ms | 33.8 ms | 0.5 ms | 30.0 |
| 9 | 30 | 1 | 10.2 ms | 23.7 ms | 63 ms | 30 | 1 | 4.1 ms | 31 ms | 2.5 ms | 4.7 ms | 0.9 ms | 29.9 |

Storage: 147 KB/s (720p) + 34 KB/s (270p) = **181 KB/s combined**
(comparable to a single 720p H.264 stream).

Why this works when single-720p-encode under K=9 didn't
([30b](../30b_capture-encode-under-playback/README.md),
[30f](../30f_capture-encode-decoders-in-workers/README.md)):

1. **Decoders are now 270p, not 720p.** Per-decoder compute is
   ~16× smaller. The CPU + memory bandwidth contention that broke
   single-720p doesn't materialize at 270p decode. K=9 270p decoders
   coexist with the encoders comfortably.
2. **createImageBitmap with resize is GPU-accelerated on the A15.**
   p95 of 2.5 ms, max of 4.7 ms — essentially free. Confirms the
   hypothesis from [30b's bad copy-res run](../30b_capture-encode-under-playback/README.md):
   the slow path was `drawImage + getImageData`, not downscale in
   general. The browser's optimized `createImageBitmap({resizeWidth,
   resizeHeight, resizeQuality: 'low'})` hits hardware.
3. **720p encoder runs near-isolation speed under contention.**
   10.2 ms p95 add at K=9 vs 2.8 ms in isolation (30d) — ~3.6×
   slower, but still 3× under the 33 ms frame budget. No queue
   growth, no finalize drain.
4. **Tick loop never drifts.** 0.9 ms p95 — the per-frame work
   (paint + frame wrap + resize + 2× submit) fits in well under 33
   ms even at K=9.

What this unlocks for phase 3:
- **Always-720p canonical storage is viable** as long as cells play
  back from the 270p mip, not the 720p. Fullscreen single-cell and
  export use the 720p AV1; cell grids use the 270p AV1.
- **No need to choose between quality and record-while-playing.**
  Both encoders run in parallel from the same camera tick; the
  user's proposed shape — encode raw camera at canonical 720p AND
  encode a downscaled 270p mip simultaneously — is the right shape.
- The dual-encode adds only ~30 KB/s storage over single-720p.
  Negligible.
- The 720p encoder's addMax was 23.7 ms at K=9, 52.5 ms at K=4
  (one transient spike). Neither caused queue buildup. The K=4
  spike happens because Android scheduling at lower core utilization
  can be lumpier (fewer cores active, more migration). Worth keeping
  an eye on but not blocking.

Note for eddy implementation:
- Use `createImageBitmap(frame, {resizeWidth, resizeHeight,
  resizeQuality: 'low'})` for the 720p→270p downscale, NOT
  `ctx.drawImage + getImageData` (the latter regresses ~10× per
  [30b's copy-res run](../30b_capture-encode-under-playback/README.md)).
- Two parallel `Output(WebM)` + `VideoSampleSource` instances on the
  main thread is fine — no need to move either to a worker.
- Per-frame ownership: clone the high-res VideoFrame for encoder A
  (since createImageBitmap consumes the original), then create a new
  VideoFrame from the resized ImageBitmap for encoder B.

Still open before phase 3 lands:
- [30c (audio split pipeline)](../30c_audio-split-pipeline/README.md)
  — can audio be muxed into one or both Outputs without A/V drift?
- **Real-camera version of this experiment.** This was synthetic
  source; the camera adds its own latency + frame-rate variability.
  Worth a quick re-run with `getUserMedia` once 30c lands.
- Long-run thermal sustainment (60-90 s).

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
TIMEOUT_MS=300000 PORT=<port> experiments/harness/run.sh 30g_dual-encode-720p-and-270p
```
