# bitmap-series

**Question:** the flow design proposes a low-res bitmap series as the
gap-filler between a take ending and its sub-atlas landing. Does it
hold up end-to-end — fast to build, cheap to paint per frame, and
robust under capture + atlas-decode contention?

## Why

10/11 found K=4-8 container-aligned sub-atlases at CSS-pixel resolution
clear realtime with margin. The remaining flow gap: between "stop
recording" and "sub-atlas v_new ready" (~30s on a 30s song), the just-
recorded cell needs *something* to paint.

Streaming the encoded clip directly works up to K=4 (per 04) but eats a
decoder per pending cell — when several takes are queued for rebuild,
the decoder budget runs out. A pre-rendered low-res bitmap series
sidesteps the decoder entirely: paint a `texImage2D(bitmap)` per frame,
no `VideoDecoder` involved.

This experiment validates the whole bitmap path: build, paint, contend.

## Setup

1. **Record** a source clip at `captureResolution`.
2. **Pre-bake** an atlas (the "settled" state that the loop is showing).
3. **Build pass.** Worker decodes the source at low res → for each
   frame, draws downscaled to a small canvas → grabs `ImageBitmap` →
   collects into an array. Report `buildMs`, frames produced.
4. **Paint pass (baseline).** Allocate a WebGL2 context. For
   `runSeconds`, simulate a render loop: each frame, for each of K
   bitmap cells, `texImage2D(bitmap[i % frames])` + draw a quad. Force
   `gl.finish()` per frame so timings are honest. Report per-frame
   paint cost and effective fps.
5. **Contended pass.** Camera capture + atlas decoder running + K
   bitmap cells painting + Worker rebuilding bitmaps for a new cell.
   All concurrent. Report capture frames, atlas fps, bitmap-paint
   fps, bitmap-rebuild ms/rate.

## What to look for

The bitmap path is viable if all four hold:

- **Build is cheap.** `buildRate ≤ ~0.5×` (much faster than the
  ~1.2× atlas rebuild). 30s clip → bitmap series in <15s, ideally
  ~2-3s.
- **Paint cost stays small.** `msPerFrame × K` ≪ 16ms (so the
  renderer has headroom for everything else).
- **Contended bitmap-build doesn't slip.** Build rate stays close to
  baseline even with capture + atlas decode running.
- **Contended paint doesn't drop frames.** Capture + atlas + K bitmap
  paints all sustain realtime.

## Note for eddy implementation

- **Hard cap on pending-bitmap cells at K=4.** Beyond K=4 simultaneous
  bitmap paints, the atlas decoder slips below realtime under
  contention (24fps at K=8). The renderer should treat K=4 as a soft
  cap on the "pending atlas rebuild" queue. Practically: at most 4
  cells in `playing-bitmaps` state at once; if more cells need it
  (unlikely with full-song loops + 3-8 takes), degrade the oldest to
  a single static frame until its rebuild lands.
- **Replaced by 12b for the rebuild-on-record case.** This experiment
  measured "build bitmaps post-stop" which is 0.34× realtime (~10s
  for 30s clip). 12b shows generating bitmaps DURING recording is
  free and instant-on-stop. Post-stop build is only needed for the
  layout-edit / cold-start dirty-atlas paths (where there's no live
  camera frame stream to tap).

## Caveats

- Source clip tiled identically (same as 05/07/09/10/11) — optimistic
  for build cost, irrelevant for paint cost.
- Bitmap allocation pattern is array-of-ImageBitmaps in memory. A
  real implementation may want OPFS-backed or ring-buffered; this
  measures the upper bound (everything in RAM).
- `texImage2D(bitmap)` upload from `ImageBitmap` is the modern fast
  path; benchmark assumes it stays so.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
PORT=<port> experiments/harness/run.sh 12_bitmap-series
```
