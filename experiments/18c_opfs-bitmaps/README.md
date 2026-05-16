# opfs-bitmaps

**Question:** [18b](../18b_progressive-overlap/README.md) OOM'd the
tab — holding K stages × N bitmaps × 270×491 RGBA ≈ 575 MB. If we
back bitmap series with OPFS instead of memory (raw RGBA frames
concatenated, one file per cell), does memory stay bounded *and* fps
hold?

## Why

18b confirmed the overlap shape works in principle but hit a hard
memory ceiling on the A15. The user's suggestion: write each
captured frame's raw RGBA to a per-cell OPFS file (zero in-memory
cost), read on demand via a pre-fetch worker. Memory becomes
constant in N (just a small ring buffer per cell).

This experiment validates the OPFS path end-to-end:

- Can `FileSystemSyncAccessHandle` write frames in a worker faster
  than the camera produces them?
- Can a reader worker keep up reading K cells × 30fps from OPFS?
- Does the render loop sustain ≥ 30fps when paint-source is
  `texImage2D(rawRgbaUint8Array)` instead of `ImageBitmap`?
- Does memory stay <100 MB across the whole 9-stage session?

## Setup

Same 9-stage progressive recording as 18b, with three pipeline
changes:

1. **Bitmap writer (per-take, in a worker):** consumes the camera's
   `VideoFrame`s via `MediaStreamTrackProcessor`, downscales to
   bitmap resolution, grabs the canvas's `ImageData`, appends raw
   RGBA bytes to a per-cell file via
   `FileSystemSyncAccessHandle.write` at frame-aligned offsets.
2. **Bitmap reader (one worker for all cells):** when a cell's file
   is committed, the reader gets an "add-cell" message with the
   file name + frame dims. It loops reading the next frame for each
   active cell, posts the raw RGBA bytes back to the main thread
   (transferable, zero-copy), throttled to 30fps per cell.
3. **Render loop:** for each OPFS-backed cell, keep the most-
   recently-received bytes; per tick, `texImage2D(..., width,
   height, RGBA, UNSIGNED_BYTE, latestBytes)`. No `ImageBitmap`
   intermediate.

The atlas rebuild + swap pipeline is unchanged from 18b
(latest-wins, background queue).

## What's measured

- **`peakHeapMb`** — sampled via `performance.memory.usedJSHeapSize`
  if available (Chrome-only). Bounded ≤ 100 MB is the target.
- All 18b metrics: `gapBeforeThisTakeMs`, `recordRenderFps`,
  `recordRenderP95Ms`, `recordRenderMaxMs`, `recordFramesOver33ms`,
  `bitmapKeepUpRatio`, `rebuildMs`, `atlasReadyDelayMs`.
- New: `opfsWriteTotalMs`, `opfsFileSizeBytes` per cell — how much
  the writer adds to recording overhead and how big the files get.

## What to look for

- **`peakHeapMb` stays under ~100 MB** — confirms OPFS-backed
  storage eliminates the OOM source
- **`recordRenderFps`** ≈ 18b's per-stage numbers — confirms the
  raw-bytes upload path is no slower than `ImageBitmap` upload
- **`recordRenderP95Ms` / `Max` / `framesOver33ms` improve vs 18b's
  jank** — less memory pressure → fewer GC stalls → smoother
- **`opfsWriteTotalMs`** ≤ ~10% of `takeSeconds × 1000` — write
  overhead doesn't materially affect the encoding pipeline

## What could go wrong

- **SyncAccessHandle contention:** if writer and reader try to open
  the same file simultaneously, only one wins. Need to make sure
  writer closes before reader opens.
- **Reader can't keep up at K=9 cells × 30fps = 270 reads/sec.**
  Each ~118 KB read. If file system is slow, frames lag and cells
  freeze. Fallback: drop reader fps per cell (15? 10? whatever
  paint quality the user accepts).
- **`getImageData` cost in the writer worker.** Per frame: draw
  VideoFrame to canvas + readback pixels. Could be slow; might
  starve the capture pipeline.
- **OPFS quota** — 9 cells × 21 MB ≈ 189 MB. Not huge but worth
  checking the cleanup path.

## Verdict (2026-05-16 · Galaxy A15 · Android 10 · Chrome 148)

**The memory ceiling is gone. Render correctness needed a fix. The
jank is contention, not OPFS.**

| stage | recordFps | p95 ms | max ms | over33ms | cam drops | opfs write |
|---|---|---|---|---|---|---|
| 1 | 58.7 | 25.2 | 31.3 | 0 | 1 | 20300 KB / 109 ms |
| 2 | 28.5 | 150.1 | 1032 | 27 | 25 | 6612 KB / 210 ms |
| 3 | 44.0 | 77.0 | 130.4 | 24 | 1 | 13920 KB / 65 ms |
| 4 | 43.1 | 69.7 | 225.3 | 20 | 20 | 13108 KB / 90 ms |
| 5 | 31.8 | 112.5 | 187.0 | 40 | 11 | 9628 KB / 92 ms |
| 6 | 35.5 | 99.4 | 145.8 | 31 | 8 | 10788 KB / 62 ms |
| 7 | 26.8 | 115.9 | 414.9 | 40 | 9 | 8004 KB / 61 ms |
| 8 | 38.3 | 87.0 | 140.1 | 32 | 15 | 10788 KB / 87 ms |
| 9 | 25.0 | 124.4 | 200.2 | 42 | 7 | 6032 KB / 47 ms |

**Memory: 10 MB peak.** Flat for the entire 75s session. The OOM
that killed 18b at ~575 MB is fully solved. ✓
**Gap between takes: 0-17 ms** (production target was "under one
frame budget" = ~33 ms). ✓
**OPFS write cost is small:** 47-210 ms for a 6 s take = 1-4% of
recording time. Negligible overhead on the encode pipeline. ✓
**Stage 1 (no concurrent rebuild) is clean:** 58 fps record, p95
25 ms, no drops. ✓
**Stages 2-9 jank heavily:** p95 70-150 ms, max up to 1 s, camera
drops 7-25 frames per take. **This is the rebuild-during-record
contention 17b documented, not anything specific to OPFS.** The
atlas rebuild for prior stages runs concurrent with the new stage's
capture; with 1 mono-atlas of N cells and linear-N rebuild cost
(per 18), later stages have heavier concurrent rebuild work.

### What we ruled out as the jank cause

- ✓ Not memory (10 MB flat)
- ✓ Not OPFS write (47-210 ms per 6 s take, tiny overhead)
- ✓ Not OPFS read (gl.getError = 0, bytes arrive on time)
- ✓ Not render work (texImage2D of raw RGBA same cost as ImageBitmap)
- **The atlas rebuild worker.** Same 17b-documented contention:
  capture + atlas-rebuild + decoders = browser rate-limits rAF
  + camera drops frames + render p95 spikes.

## Note for eddy implementation

- **`gl.clear` per frame is MANDATORY on Android Chrome.** Without
  it, the framebuffer doesn't reliably present cells whose textures
  weren't the most-recently-uploaded. The bitmap cells were
  silently invisible until the clear was added. Production renderer
  must clear (any color; black is the natural placeholder) at the
  start of every `rAF` tick. This is the standard
  `preserveDrawingBuffer: false` pattern but a real bug if missed.
- **OPFS is the bitmap storage path.** Raw RGBA frames concatenated
  in one file per cell, written by a worker during recording via
  `FileSystemSyncAccessHandle`, read by a long-lived reader worker
  posting to main as transferable `ArrayBuffer`s. Direct
  `texImage2D(..., width, height, RGBA, UNSIGNED_BYTE, Uint8Array)`
  on main. Memory peak: ~10 MB regardless of session length.
- **Two SyncAccessHandles can't be open on the same file.** Writer
  must close before reader opens. The worker's `close()` releases
  the lock synchronously; main waits for writer's "done" message
  before posting "add-cell" to reader. No retry needed.
- **The rebuild-during-record jank is inherent**, not an OPFS
  artefact. The flow design assumes user-paced inter-take gaps
  (~1-3 s of decision time) absorb the rebuild concurrent with the
  next take. 18c's back-to-back synthetic flow has gap≈0 → maximum
  contention. Real human-paced sessions should see less. The
  longer-term mitigation is **K leaf-container atlases (11)** so
  each rebuild is smaller (only the changed container) instead of a
  mono-atlas with linear-N rebuild cost.

## Caveats

- v1 reads via postMessage + transferable ArrayBuffer (zero-copy
  but main-thread serialization). A `SharedArrayBuffer` ring would
  be faster but requires COOP/COEP headers; deferred.
- v1 uses one shared reader worker for all cells; if it can't keep
  up, per-cell workers are the next move.
- OPFS files are cleaned up at session end. Persistence across
  sessions (cold-start with pre-built bitmap files) is a separate
  concern.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
TIMEOUT_MS=300000 PORT=<port> experiments/harness/run.sh 18c_opfs-bitmaps
```
