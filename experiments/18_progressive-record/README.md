# progressive-record

**Question:** does the full pipeline compose? Run the eddy flow at
miniature scale — record into cell 1, split, record into cell 2,
split again, record into cell 3, etc. — for 9 stages. What breaks?
What's smooth? Where does the timing actually land when everything
runs together?

## Why

Experiments 12-17 each validated *one* piece of the architecture in
isolation:

- 12 / 12b — bitmaps as gap-filler, generated during recording
- 13 — atlas persistence + cold-start
- 14 / 16 — atlas swap with pre-warmed bitmap-hold
- 15 — distinct content barely affects atlas cost
- 17 / 17b — render fps (60 steady-state, 22 contended)

This experiment is the first integration: nine takes back-to-back,
each split adding one cell to the layout, the previously-recorded
cells playing while the new cell records. It exercises the whole
hot-path — record → bitmap → atlas rebuild → swap → repeat — at
real-flow scale.

## Setup

Layout: the viewport is divided into N equal slices, stacked
top-to-bottom (full-width × `canvasH/N` tall — preserves camera-ish
aspect on a portrait device). No grid; just N slices. Stage 1 is
fullscreen, stage 2 is top half + bottom half, stage 3 is thirds,
etc.

The last (newly-added) cell is the live camera; the rest play from
the sub-atlas of all previously-recorded clips.

The sub-atlas decomposition follows the simplest production model:
**one sub-atlas per stage**, containing all N clips arranged in
N×1 cells. (A real layout might split into multiple sub-atlases per
the container tree; for this integration test, one is enough to
exercise the rebuild path.)

Per stage:

1. Add new cell on the right; live camera bound to it
2. Start `MediaRecorder` for `takeSeconds` (6s) + `MediaStream-
   TrackProcessor` + worker emitting bitmaps per frame (12b)
3. Render loop paints: existing cells from latest atlas, new cell
   from `<video>`
4. At `takeSeconds`, stop capture; bitmap series is ready (12b)
5. Cell switches source: `<video>` → bitmap-series
6. Worker rebuilds sub-atlas with all N clips (15's
   `compositeDistinct`)
7. When rebuild lands: pre-warm new atlas decoder, hold first
   bitmap (16's pattern), swap all cells to new atlas, free
   bitmap series
8. Brief settle gap, advance to stage N+1

Repeat for 9 stages.

## What's measured

Per stage:
- `captureFrames` — does it stay clean as the layout grows?
- `recordRenderFps` — render fps while capture is running
  (= contended; 17b's case at growing N)
- `rebuildRenderFps` — render fps while the worker is building
  (no capture, but K decoders + worker; lighter contention)
- `rebuildMs` — sub-atlas build time at this N
- `bitmapBuildKeepUpRatio` — bitmap-during-record output rate
  (per 12b)
- `stageWallClockSeconds` — record → atlas-ready

Plus a session summary:
- Total session seconds
- Min / max / mean fps across all stages
- Total bytes written (clips + atlases)

## What this surfaces that micro-experiments couldn't

- **Cumulative N effect.** Each stage has more decoders contributing
  more contention to the next stage's recording. How does fps scale
  with stage number?
- **Real layout transitions.** Layout reshapes between every take.
  Does the renderer handle the layout swap cleanly?
- **End-to-end timing.** Does the build-during-record-of-next-take
  shape actually deliver "next stage ready before its take ends"
  consistently, or do builds queue up?
- **Anything we haven't thought to look for.** This is the first
  test where it's easier to *see* a bug than predict it from
  component numbers.

## What might fail

- Atlas decode contention rises with N (more cells per atlas, but
  still 1 atlas; per 11 / 15 should hold)
- Build cost grows with N (more cells in the composite). At N=9,
  build of 9 cells × 6s ≈ 9 × 6 × 1.2 = ~65s? No — composite scales
  with TOTAL FRAMES of output, not N × source-clip frames. Output
  = 6s of atlas frames regardless of N. So build cost stays
  ~constant per stage (~7s for a 6s clip per 08). Sanity-check this
  against the actual numbers.
- Capture during a 9-cell stage might suffer more than 17b's K=4
  case did — but the additional pixels are all painted, not
  encoded; should still hold
- The bitmap-during-record worker handling 9 active cells (8 sub-
  atlas + 1 live record) is a new combination

## Verdict (2026-05-16 · Galaxy A15 · Android 10 · Chrome 148)

Nine stages ran end-to-end without crashes, broken cells, or
data-loss. Session total **135.9s for 9 × 6s takes**. Per stage:

| stage | cells | recordFps | rebuild ms | rebuild × | rebuildFps | bitmap keep-up |
|---|---|---|---|---|---|---|
| 1 | 1 | 57.7 | 7128 | 1.19 | 37.2 | 98% |
| 2 | 2 | 53.9 | 4960 | 0.83 | 45.9 | 98% |
| 3 | 3 | 58.6 | 5680 | 0.95 | 51.5 | 101% |
| 4 | 4 | 58.3 | 6885 | 1.15 | 51.0 | 101% |
| 5 | 5 | 59.3 | 8127 | 1.35 | 50.6 | 101% |
| 6 | 6 | 59.4 | 9440 | 1.57 | 49.2 | 101% |
| 7 | 7 | 59.2 | 10767 | 1.79 | 49.4 | 101% |
| 8 | 8 | 59.3 | 12062 | 2.01 | 54.7 | 99% |
| 9 | 9 | 55.9 | 13020 | 2.17 | 50.0 | 103% |

**Three big findings:**

1. **Recording stays near 60fps** — much better than 17b's contended
   22fps. The difference: 18's recording phase has capture + 1 atlas
   decoder, *no* concurrent rebuild (rebuild waits until after
   stop). When you don't run the rebuild *during* the take, recording
   is fluid.

2. **Rebuild render fps is also smooth (37-55fps)** — even with the
   worker rebuilding + decoder running, no capture contention keeps
   things above 30fps.

3. **NEW: rebuild cost grows linearly with N (~0.2× per cell added).**
   At N=1: 1.19× realtime; at N=9: 2.17×. Per-output-frame work
   scales with N because `compositeDistinct` decodes N source clips
   and draws N tiles per output frame. The earlier "output frames
   are constant, cost is constant" hypothesis was wrong.

   At N=9 in one atlas, rebuild for a 6s take takes 13s. For a 30s
   take it'd be 65s — longer than the take itself. **Mono-atlas
   doesn't scale past ~5-6 cells.**

4. **Bitmap-during-record holds at 9 cells** — 98-103% keep-up across
   every stage. The pipeline isn't strained.

### What this experiment did NOT measure (and what 18b will)

- **The realistic between-takes gap.** 18 serializes (record → wait
  for rebuild → record next), so the apparent "gap" = rebuild time
  (7-13s). In production we'd overlap: new cell flips to bitmaps
  the moment recording stops, next take starts immediately, atlas
  rebuild happens in background. The user-visible gap should be
  ~0ms. 18b will model this and measure it.
- **Per-frame jank.** Mean fps is 54-59 but visible jank reported on
  device. 18 only reports averages — need p95 / max / "frames over
  33ms" per stage to surface outliers.
- **Recording integrity.** We have chunk *counts* per take but not
  per-frame timestamps. 18b will demux + compare actual timestamps
  to expected, surface dropped frames.

## Note for eddy implementation

- **Cap cells-per-leaf-atlas at ~4** in production. 11 already
  pointed at container-aligned sub-atlases; this experiment shows
  *why* it's mandatory at scale. Mono-atlas of N cells walls at the
  linear-N rebuild cost (N=9 → 2.17× realtime; N=16 → ~4.2×). With
  K=4 leaf containers each holding ≤4 cells, every container
  rebuild stays at ≤1.2× realtime regardless of how many total
  cells the user adds.
- **Don't rebuild during the take itself.** 09's "build during
  recording" was already falsified at full atlas; 18 confirms the
  opposite is also true — record alone runs near 60fps, rebuild
  alone runs near 50fps, *both at once* (= 17b's contended case)
  drops to 22fps. Serializing record-then-rebuild keeps both fast.
- **Bitmap-during-record stays solid at scale.** 12b's 100% keep-up
  held across 9 stages with growing layout complexity. The bitmap
  worker is genuinely a write-and-forget piece.

## Caveats

- 6s takes (not 10s as user originally described) to fit harness
  TIMEOUT_MS. Same flow shape; just scaled.
- Sequential, not parallel — each stage waits for prior atlas
  build before starting next. A real session might overlap more
  aggressively; that's a future test.
- One sub-atlas per stage. A leaf-container-per-strip layout
  would be K=N sub-atlases — also future.
- No audio loop / playhead pacing — we just iterate stages
  immediately. Renderer doesn't simulate musical timing.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
PORT=<port> experiments/harness/run.sh 18_progressive-record
```

(May need `TIMEOUT_MS` bump in `experiments/harness/run-cdp.ts` —
total run time ~100-120s.)
