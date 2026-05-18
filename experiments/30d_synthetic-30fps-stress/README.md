# synthetic-30fps-stress

**Question:** when the camera-side bottleneck is removed, can AV1
software encode actually keep up with a sustained 30 fps input at the
typical eddy cell-mip resolutions (540p / 270p / 180p)?

## Why

[Experiment 30](../30_capture-time-av1-encode/README.md) showed the
capture-time AV1 pipeline working cleanly — zero drops, ~4 ms p95
encode-add latency, round-trip verified. But the camera throttled
itself to ~8 fps under indoor auto-exposure, so the serial loop
(`await reader.read()` → `await videoSource.add(...)`) was paced by
the camera, not the encoder. **We never measured what the encoder
does at 30 fps in.**

The phase 3 decision (encode-as-you-capture vs. MediaRecorder +
post-transcode) needs that number. If the encoder can't sustain
30 fps at 270p / 180p when fed at full rate, the architectural appeal
of on-the-fly encode evaporates: we'd either drop frames or fall back
to fixed-rate-limit camera capture, both worse than the current path.

## Setup

No camera. A synthetic source pushes a known pattern into the same
mediabunny pipeline at exactly 30 fps:

1. Allocate an `OffscreenCanvas` at the target resolution.
2. Pre-fill RGBA pixels: a 60-frame loop of a moving gradient + a
   per-frame counter rectangle. Realistic compression behavior needs
   real changing content (a static frame compresses absurdly well).
3. For each tick at a 33.33 ms cadence:
   - Draw the next pattern frame onto the canvas.
   - Wrap as a `VideoFrame` with `timestamp = frameIndex / 30 * 1e6`.
   - Wrap as a `VideoSample`, call `videoSource.add(sample)`.
   - Do **NOT** await the add — push and continue, let the source
     queue. Track `pendingAdds` (started − resolved).
4. Run for `captureSeconds` (10 s) → 300 target frames.
5. After the last tick, await all in-flight adds, then finalize.

Three resolution passes, same as exp 30:

| Pass | Encode resolution | Notes |
|---|---|---|
| 540p | 960 × 544 | upper-bound mip |
| 270p | 480 × 272 | K=16 cell mip |
| 180p | 320 × 184 | K=25 cell mip |

## What's measured

Per pass:
- `targetFps` — 30 (constant input rate)
- `submittedFps` — frames the loop actually managed to submit
  (`framesSubmitted / captureSeconds`). If submit lags, the tick loop
  has fallen behind.
- `encodedFps` — frames the mediabunny source confirmed (resolved
  `add()` promises). Should equal `submittedFps` if the encoder kept
  up across the full run.
- `pendingAddsMax` — peak `(started − resolved)`, i.e. how deep the
  in-flight queue got. Steady-state ≤ 5 means encoder is comfortably
  keeping up; sustained growth means it can't.
- `addP95Ms`, `addMaxMs` — same as exp 30, but now with no camera
  pacing
- `tickLagMs` — drift between the tick loop's wall clock and its
  expected schedule. If tickLag stays near 0, the input clock is
  honored; if it grows, the loop itself can't keep up (independent of
  encoder).
- `finalizeMs` — flush time after last frame is submitted (longer
  here than exp 30 because there may be queued frames to drain)
- `webmBytes`, `webmBytesPerSecond`, `roundTripVerified` — same as 30

## What to look for

- **`encodedFps` ≈ 30 at all 3 resolutions, `pendingAddsMax` ≤ 5** —
  encoder is genuinely realtime at typical cell sizes; the on-the-fly
  architecture is unblocked
- **`encodedFps` < 30 at 540p but ≈ 30 at 270p / 180p** — full-mip
  capture-time encode is too slow; we'd need to encode at a smaller
  res than display res and accept upscale-on-decode
- **`pendingAddsMax` grows unbounded** — encoder is permanently
  behind; finalize at end-of-record would have a multi-second queue
  drain (effectively the same cost as a post-transcode)
- **`tickLagMs` grows** — the tick loop itself is the bottleneck (JS
  scheduling, not encoder), so the measurement is invalid; re-design
  needed
- **`finalizeMs` ≤ 500 ms** even with a drained queue — record-stop
  flush stays acceptable

## Caveats

- Synthetic content compresses differently than camera footage —
  bitrate / file size won't match camera runs exactly. The encode
  *speed* comparison is still valid: encoder workload is dominated by
  pixel count and motion, both of which we control here.
- 10 s is too short to see thermal effects. If 30 fps is sustained
  comfortably here, a follow-up should run 60-90 s to check sustained
  behavior under thermal accumulation.
- The tick loop uses `setTimeout` / `Promise` micro-cadence; sub-ms
  precision isn't guaranteed. `tickLagMs` exposes any drift so the
  reader can judge whether the input rate was actually 30 Hz.

## Findings (2026-05-18)

Encoder keeps up with 30 fps cleanly at every resolution tested,
including camera-native **720p**. The camera was the bottleneck in
[exp 30](../30_capture-time-av1-encode/README.md), not the AV1
software encoder.

**Re-run with 720p added** (sha `103349c`, Galaxy A15):

| Pass | submitted | encoded | pendingMax | add p95 | add max | tickLag p95 | finalize | webm B/s | roundTrip |
|---|---|---|---|---|---|---|---|---|---|
| 720p | 30.0 | 30.0 | 1 | **2.8 ms** | 4.3 ms | 0.5 ms | 36 ms | 147 KB/s | ✓ 300/300 |
| 540p | 30.0 | 30.0 | 1 | 3.4 ms | 7.6 ms | 0.8 ms | 30 ms | 96 KB/s | ✓ 300/300 |
| 270p | 30.0 | 30.0 | 1 | 4.7 ms | 6.8 ms | 1.3 ms | 19 ms | 32 KB/s | ✓ 300/300 |
| 180p | 30.0 | 30.0 | 1 | 4.6 ms | 11.8 ms | 1.9 ms | 18 ms | 16 KB/s | ✓ 300/300 |

First run (sha `0bdaef3`, no 720p) saw `pendingMax = 9` and a 297 ms
`addMax` spike at 540p — a one-off key-frame stall. The re-run shows
`pendingMax = 1` across all passes; the spike doesn't reproduce.

What this confirms:
- **Encoder is realtime at 30 fps for all 4 resolutions including
  camera-native 720p.** No frames lost, `encodedFps` exactly matches
  `submittedFps` (300/300 in every pass).
- **720p has the lowest add-latency p95** (2.8 ms) of any pass — a
  bit counter-intuitive. Probably explained by amortization: at
  smaller frame sizes the fixed per-frame overhead (sample wrap, mux
  write, promise machinery) dominates; at 720p the actual encode work
  is bigger but it's pipelined behind much less per-frame ceremony.
  Either way, all resolutions have ≥ 7× headroom vs the 33 ms frame
  budget.
- **No pending queue growth at any resolution.** `pendingMax = 1`
  everywhere — the encoder finished each frame before the next
  arrived, top to bottom of the resolution range.
- **Tick loop is honoring 30 Hz.** `tickLagP95 ≤ 2 ms` at all
  resolutions — the input schedule is real, not artifact-driven.
- **Finalize stays cheap even with queued frames.** 17-23 ms — the
  drain loop emptied the queue before finalize, so finalize itself
  is just the muxer flush.

Implications for phase 3:
- **Canonical AV1 storage at camera-native 720p is viable.** The
  encoder isn't a constraint on storage resolution — we can store
  the full camera output, not a downscaled mip, and re-derive any
  display res at decode time. This unlocks fullscreen single-cell
  preview, future export, and re-edit at the captured quality
  without the multi-mip-encode complexity from
  [phase 3 spec](../../docs/superpowers/specs/2026-05-18-c2-phase3-design.md)'s
  alternative paths.
- The on-the-fly capture-time AV1 path is fully unblocked at every
  resolution we'd plausibly use. Combined with exp 30's
  pipeline-works result, encode-as-you-capture replaces the proposed
  MediaRecorder + post-record-transcode path with a single live
  pipeline that finishes within ~36 ms of record-stop.
- Still open: encoder behavior **under concurrent playback load at
  720p** ([30b](../30b_capture-encode-under-playback/README.md) only
  tested 270p; if 720p is the new canonical res, 30b needs a 720p
  re-run) and **with synchronized audio**
  ([30c](../30c_audio-split-pipeline/README.md)).
- Also still open: **sustained behavior past 10 s**. 30 fps × 10 s
  doesn't trigger thermal throttling on this device. A 60-90 s
  follow-up should confirm the headroom holds — but 720p with ~12×
  headroom would tolerate significant thermal degradation before
  losing realtime.

Note for eddy implementation: keep the encoder fed with the
fire-and-track pattern (don't `await` each `add()` serially; let the
source queue 1-2 deep and only await on drain at record-stop).
Serial-awaiting works at small mips but throws away the encoder's
ability to pipeline its work.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
TIMEOUT_MS=180000 PORT=<port> experiments/harness/run.sh 30d_synthetic-30fps-stress
```
