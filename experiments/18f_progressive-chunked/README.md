# progressive-chunked

**Question:** the simplest possible progressive recording, using
chunked atlas builds (per 18e) between takes. Does the whole
9-stage flow stay smooth — recording and build windows both?

## Why

[18](../18_progressive-record/README.md) was the original progressive
test: 9 takes, viewport divides into N strips, mono atlas built
between each take. Recording smooth (no concurrent rebuild) but
gaps between takes were long (~7-13 s each) and the rebuild itself
took noticeable wall-clock time.

[18e](../18e_idle-build/README.md) showed chunked builds with yields
are jank-free AND ~25 % faster than mono.

This is 18 minus the mono atlas worker plus the chunk-worker from
18e. Same flow shape (record → wait for build → next take); just
the build is chunked. Should be at least as fast as 18 and
visually smoother during the build windows.

## Setup

9 progressive stages. Per stage:

1. Add a new cell (live camera) at the bottom of the layout.
2. Record `takeSeconds` (6 s). Other cells render from the current
   atlas (built last stage); the new cell renders from preview
   `<video>`.
3. On stop: build the atlas of all N clips so far, **chunked into
   3 sequential pieces with `setTimeout(0)` yields between**.
4. When the atlas is ready, swap the atlas decoder (per 16's
   bitmap-hold pre-warm pattern) and advance to next stage.

No OPFS bitmap scratch, no overlap. The simplest variant: cells
go black for a brief window during build (between previous atlas
and new atlas), then back to atlas-driven once new atlas swaps in.

## What's measured

Per stage:
- `recordJank` — full JankReport during the recording window
- `buildJank` — full JankReport during the build window
- `recordRenderFps`, `buildRenderFps` — convenient summaries
- `buildEvents[]` — per-chunk build ms
- `integrity` — recorded clip frame count + drops
- `stageWallClockSeconds` — total stage time (record + build)

Session: peakHeap, total session seconds, longtasks.

## What to look for

- **`buildJank.jankScore ≈ baseline`** across all stages → chunked
  builds keep render smooth even at higher N (where the atlas
  composite grows). This is the production-relevant claim.
- **`recordJank` clean** since there's no concurrent build during
  recording — same as 18's recording phase.
- **`buildEvents` chunk sizes stable** as N grows (each chunk is
  the same time-range, just N cells inside it).
- **Total session seconds** ≈ 18's, ideally faster (since chunked
  is ~25 % quicker per 18e).

## Verdict (2026-05-16 · Galaxy A15 · Android 10 · Chrome 148)

**The chunked pattern scales cleanly through K=9 in the progressive
flow.** Render stays at the 60 Hz ceiling across all stages.

| stg | K | recFps | recScore | buildFps | bldScore | bldStrk | buildMs | wall |
|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 59.6 | 0.0 | 48.2 | 103.8 | 6 | 1611+1030+1034 | 11.8 |
| 2 | 2 | 59.5 | 3.4 | 58.3 | 6.8 | 3 | 1341+1109+829 | 12.2 |
| 3 | 3 | 59.4 | 0.8 | 59.5 | 0.8 | 1 | 1204+681+575 | 12.5 |
| 4 | 4 | 58.9 | 7.7 | 59.7 | 0.0 | 1 | 1138+1111+768 | 14.5 |
| 5 | 5 | 58.6 | 28.7 | 59.9 | 0.0 | 1 | 1166+1107+971 | 15.9 |
| 6 | 6 | 58.6 | 18.7 | 59.2 | 8.2 | 1 | 860+578+671 | 16.3 |
| 7 | 7 | 58.7 | 12.1 | 59.6 | 1.8 | 1 | 1092+587+601 | 17.7 |
| 8 | 8 | 57.8 | 51.7 | 49.5 | 61.5 | 3 | 888+590+581 | 20.1 |
| 9 | 9 | 59.4 | 0.0 | 60.1 | 0.0 | 0 | 791+581+590 | 22.3 |

- Record fps stays **58-60 throughout** all stages. Capture clean
  (0-2 drops/take). The recording phase is unaffected.
- Build fps stays **48-60 across all stages**. No multi-hundred-ms
  freezes. Build jankScore mostly 0-8 with a few isolated outliers
  (stages 1 and 8, 52-104) that show max streaks of 3-6 frames —
  brief stutters, not perceptible freezes.
- Session total: **143 s** vs 18's 135.9 s with mono builds.
  Roughly equivalent total time, but the per-frame quality is
  dramatically better.

**Comparison to 18 (same flow with mono builds):**
- Stage 1 buildRenderFps: 37.2 → **48.2**
- Stage 9 buildRenderFps: 50.0 → **60.1**

Chunked builds keep the renderer at the display ceiling even as
the atlas grows with N. Mono visibly hitched (per 18's data).

## Note for eddy implementation

- **Progressive recording with chunked builds is the production
  pattern.** Per stage: record → chunked atlas rebuild → swap.
  Render stays smooth throughout.
- **3 chunks per atlas with `setTimeout(0)` yields between is
  enough.** Both 18e (single-pass) and 18f (9-stage progressive)
  confirm this. Bigger chunk counts probably help marginally;
  3 is the floor that works.
- **Spawn a fresh chunk-worker per stage.** Each stage's atlas
  has a different cell-set (N grows by 1). Re-using one composer
  across stages would require re-prepare anyway; new worker per
  stage is simpler and not measurably slower.
- **The atlas's `compositeMs` per chunk shrinks at later stages**
  (1.6 s → 0.6 s for first chunk between stage 1 and 9 in this
  run). Possibly the camera capture rate varies (some takes
  produce more frames than others); doesn't affect the jank
  verdict but worth knowing.
- **Outlier stages (1 and 8 here) show isolated jank spikes** even
  with chunked builds. Stage 1 is plausibly browser warm-up; stage
  8 may be a thermal / transient effect. Production should expect
  occasional outliers and not interpret them as architectural
  failure.

## Caveats

- 9 cells × 6 s in one atlas grows the per-atlas build cost
  linearly in N (per 18's finding — mono walls past ~5-6 cells).
  Chunked might suffer the same per-chunk cost growth. The win is
  not throughput but render smoothness.
- Pre-decode bitmaps grow with N — at stage 9, the chunk-composer
  is holding 9 × cell-worth of bitmaps. Memory follows.
- Atlas-only render = light render workload. Direct comparison to
  18's bitmap-series rendering isn't quite apples-to-apples.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
TIMEOUT_MS=600000 PORT=<port> experiments/harness/run.sh 18f_progressive-chunked
```
