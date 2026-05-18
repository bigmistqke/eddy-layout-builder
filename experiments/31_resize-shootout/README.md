# resize-shootout

**Question:** which 720p→270p downscale technique is fastest on the
Galaxy A15 when fed real-camera `VideoFrame`s, and which is suitable
for the dual-encode capture pipeline from
[exp 30g](../30g_dual-encode-720p-and-270p/README.md)?

## Why

[Exp 30g](../30g_dual-encode-720p-and-270p/README.md) used
`createImageBitmap(frame, {resizeWidth, resizeHeight, resizeQuality:
'low'})` and found it ~2.5 ms p95 — essentially free. But:

- That was a **synthetic** input (already an `OffscreenCanvas`).
  Real camera `VideoFrame`s may be NV12 or another GPU-internal
  format; the resize fast path could behave differently.
- We never measured other techniques in apples-to-apples comparison.
  The architecture decision in 30g rested on one method.
- The user's instinct: "we need a separate test that analyzes the
  cost of different resizing techniques (canvas API, webgl, webgpu,
  …)". This experiment is that test.

## Setup

1. `getUserMedia({video: {width: 1280, height: 720}})`.
2. `MediaStreamTrackProcessor` to read `VideoFrame`s.
3. For each captured camera `VideoFrame` (up to `targetFrames` total):
   - Run **every technique** against a clone of that frame
   - Measure each technique's wall-clock cost
   - Push the produced 270p `VideoFrame` into a per-technique AV1
     `VideoSampleSource` for round-trip validation
4. After `targetFrames`, finalize each per-technique encoder and
   verify the WebM round-trips (frame count + decoder accepts).

Techniques tested (in order, per frame):

| Method | Description |
|---|---|
| `createImageBitmap-low` | `createImageBitmap(frame, {resize…, quality:'low'})` |
| `createImageBitmap-medium` | same with `'medium'` |
| `createImageBitmap-high` | same with `'high'` |
| `canvas2d-wrap` | `ctx.drawImage(frame, 0, 0, 480, 272)` then `new VideoFrame(canvas, {timestamp})` (no readback) |
| `canvas2d-transfer` | `ctx.drawImage` then `canvas.transferToImageBitmap()` then `new VideoFrame(bitmap)` |
| `webgl` | upload frame as `TEXTURE_2D`, draw a full-canvas quad on a 480×272 GL canvas, then `new VideoFrame(canvas)` |
| `webgpu` | (feature-detected) compute or render pass downscaling into a 480×272 texture, then `new VideoFrame(canvas)` |

Running all techniques per frame keeps comparisons fair (same input
content, same camera state). The cost is that per-frame work is
heavy, which may drop camera frames — but that only reduces sample
size, not measurement validity, since each technique's cost is
recorded independently.

## What's measured

Per technique:
- `setupMs` — one-time setup cost (program compile, context
  initialization)
- `p50Ms`, `p95Ms`, `maxMs` — per-frame resize cost
- `samples` — frames the technique successfully ran on
- `availableInWorker` — was the technique callable in this context
  (skipped if unavailable, e.g. WebGPU)
- `encodeRoundTrip` — `{framesSubmitted, framesEncoded, roundTripDemuxed, ok}`
- `errors`

Per session:
- `cameraSettings` — width/height/frameRate actually negotiated
- `framesCaptured` — total camera frames pulled

## What to look for

- **createImageBitmap-low ≤ 3 ms p95** — confirms 30g's finding for
  real camera input
- **createImageBitmap-medium / -high cost ≫ low** — quality knob is
  not free; production should stick with `low`
- **canvas2d-wrap is cheaper than canvas2d-transfer** — wrapping a
  canvas as a VideoFrame avoids the explicit ImageBitmap step
- **webgl ≪ canvas2d** — GPU bypass beats 2D context
- **webgl ≈ createImageBitmap-low** — both hit the same hardware
  fast path, so neither is dramatically better
- **webgpu unavailable** — Android Chrome 148 might not have WebGPU
  enabled; expected to be skipped
- **All round-trip OK** — every method produces a valid VideoFrame
  the encoder accepts (otherwise the method can't be used in the
  pipeline regardless of speed)

## Caveats

- Cost includes the `new VideoFrame(…)` wrap, which is what
  production actually needs. Methods that produce an
  `ImageBitmap` first pay the wrap cost too.
- Real camera frames vary frame-to-frame (auto-exposure, motion);
  doesn't affect timing meaningfully but may affect encoded bytes.
- Single 5 s session, single device. Thermal effects untested.
- Visual quality is NOT compared here. Per-pixel fidelity assessment
  is out of scope — we're measuring throughput. A separate visual
  check (sample one frame per method, eyeball it) is a follow-up.
- WebGL setup uses raw WebGL2 (not the codebase's `view.gl`
  abstraction) so the per-frame cost reflects pure GPU work, not
  abstraction overhead.

## Findings (2026-05-18, sha `ba78188`, Galaxy A15)

All 7 techniques produced valid VideoFrames that round-tripped through
AV1 encode/demux. Per-frame resize costs (150 samples, real camera
input at 1280×720):

| Technique | p50 | p95 | max | setup |
|---|---|---|---|---|
| **webgl** | **0.8 ms** | **1.7 ms** | 4.4 ms | 381 ms |
| canvas2d-wrap | 1.4 ms | 2.9 ms | 9.3 ms | 2 ms |
| createImageBitmap-medium | 2.6 ms | 4.1 ms | 5.9 ms | 3 ms |
| canvas2d-transfer | 2.6 ms | 6.0 ms | 8.7 ms | 2 ms |
| createImageBitmap-low | 2.8 ms | 4.5 ms | 12.5 ms | 7 ms |
| createImageBitmap-high | 2.8 ms | 5.6 ms | 8.3 ms | 2 ms |
| webgpu | 19.2 ms | 46.9 ms | 169.9 ms | 80 ms |

Surprises:

1. **WebGL is the clear winner.** 0.8 ms p50, 1.7 ms p95 — 1.6-3.5×
   faster than every other method. The 381 ms setup is one-time and
   amortizes over the session. This is the production-recommended path
   for the dual-encode resize step.
2. **WebGPU is the slowest, by a lot.** 19 ms p50, 47 ms p95, 170 ms
   max — counter-intuitive. Likely causes:
   - `importExternalTexture` may force a YUV→RGB copy each call (the
     external-texture extension exists precisely to avoid this, but
     Android Chrome's WebGPU implementation may not honor that fast
     path)
   - This experiment awaits `queue.onSubmittedWorkDone()` to measure
     end-to-end cost; WebGL's `gl.finish()` is similar in intent but
     may be lighter on this driver
   - WebGPU on Android Chrome 148 is still maturing — the slow path
     may improve over time
3. **createImageBitmap quality knob barely matters** on this device.
   `low` / `medium` / `high` all within 1 ms of each other — no need
   to sacrifice quality for performance with this API. Picking `low`
   in 30g cost us nothing visually.
4. **canvas2d-wrap (no extract step) beats createImageBitmap.**
   1.4 ms p50 vs 2.8 ms — wrapping the OffscreenCanvas directly as
   a VideoFrame avoids the bitmap-creation overhead.
5. **canvas2d-transfer ≈ createImageBitmap-low.** Both pay the
   explicit ImageBitmap creation; ~2.6-2.8 ms p50.

Why the original 30b "270p copy" path was so slow:
- That used `ctx.drawImage` + `ctx.getImageData` (NOT a technique
  measured here — it's the slowest path because `getImageData` forces
  a full CPU readback). Avoid this in production.

Implications for phase 3:
- **Switch the 30g dual-encode resize from `createImageBitmap-low` to
  WebGL** — saves ~3 ms per frame on the resize step. At 30 fps that's
  ~90 ms/s of headroom freed up. Worth doing, especially since the
  720p encoder already runs at 10 ms p95 add — trimming the resize
  cost shifts more budget back to the encoder.
- **Fall back to canvas2d-wrap if WebGL setup fails** — it's only
  ~1.5× slower than WebGL and has a 2 ms setup cost. Wrapping a
  canvas as a VideoFrame (no transferToImageBitmap, no getImageData)
  is the cheapest pure-2D-canvas path.
- **Skip WebGPU for now.** Even if the slow path is later optimized,
  there's no headroom advantage over WebGL on this device today.
- **createImageBitmap is a fine fallback** if both WebGL and 2D-canvas
  paths fail; quality knob is free, so pick `medium` or `high`.

Note for eddy implementation: WebGL setup is 381 ms one-time — that's
significant if measured per record-start. Initialize the resize
context once at app boot and reuse across record sessions; don't
build/teardown per clip.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
TIMEOUT_MS=180000 PORT=<port> experiments/harness/run.sh 31_resize-shootout
```
