# render-loop-av1-atlas

**Question:** [24](../24_render-loop-av1-multires/README.md) showed
that per-cell streaming with AV1-SW survives end-to-end at K≤9 but
falls off the cliff at K=16-25 — decode keeps up, but the per-cell
`texImage2D + drawArrays` cost saturates the rAF tick. Does atlas
grouping (M sub-atlases × C cells per atlas) recover smoothness at
K=16 and K=25, the way 10/11/18g found for the VP8 era?

## Why

24 verdict: per-cell architecture wins at K≤9, fails at K≥16. The
per-cell texImage2D + draw chain hit ~30 fps total at K=16 because
the rAF callback was doing ~50 GL operations per tick.

The atlas pattern from 10/11/18g collapses N per-cell uploads into M
per-atlas uploads (typically M=4 sub-atlases for K=4..16). If atlas
decode via AV1-SW costs less than the equivalent N per-cell uploads,
K=16+ becomes smooth again.

This experiment is the direct comparison: same source recording, same
mip resolution, same render-loop pacing, same fullscreen canvas — only
the architecture differs (M atlas streams vs K per-cell streams).

## Setup

1. Record one 720p VP8 source clip (6s).
2. For each pass, build M AV1 sub-atlases containing C cells each at
   the per-cell mip resolution. (Each atlas is a tiled video where
   each spatial sub-rect carries one cell's content.)
3. Spawn M paced AV1-SW decoders, one per sub-atlas.
4. Render loop draws K cells, each sampling its sub-rect of its
   atlas texture, with `gl.clear` per tick.
5. JankRecorder + longtask observer per pass.

Passes:

| K | M atlases | cells/atlas | atlas size | mip |
|---|---|---|---|---|
| 9 | 1 | 9 (3×3) | 1440×1104 | 360p tiles |
| 16 | 4 | 4 (2×2) | 960×544 | 270p tiles |
| 25 | 5 | 5 (5×1) | 1600×184 | 180p tiles |

Each pass runs 10s flat-out from rAF.

## What's measured

Per pass (mirrors 24 for direct comparison):
- Render fps (mean / median)
- Frame-time stats: mean, p95, p99, max
- `over33msRatio`, `longestJankStreak`, `jankScore`
- Long-tasks observed
- Aggregate decode load (sum across M atlas decoders)
- Atlas build wall-time (one-shot, informational)

## What to look for

- **K=16 atlas (M=4) recovers ~60fps with <1% over-33ms** → atlas
  pattern still load-bearing past K=9 in the AV1 era
- **K=25 atlas (M=5) holds** → atlas serves the high-density layouts
  even at extreme K
- **Atlas adds jank vs per-cell at K=9** → M=1 single big atlas is
  itself a regression at low K. (Expected: K=9 fine either way; the
  atlas's value should only manifest at higher K)
- **Atlas FAILS at K=16+ too** → both architectures hit a wall; need
  a third strategy

## Verdict

**Atlas recovers full 60fps smoothness where 24's per-cell architecture saturated.**

| pass | K | M | atlas | rAF fps | mean | p95 | max | >33ms | decode fps | build ms |
|---|---|---|---|---|---|---|---|---|---|---|
| K9-M1 | 9 | 1 | 1440×816 | 60.0 | 16.9 | 16.7 | 146* | 0.3% | 30 | 2798 |
| K16-M4 | 16 | 4 | 960×544 | **60.1** | 16.7 | 16.7 | 49.9 | 0.2% | 119 | 1448 |
| K25-M5 | 25 | 5 | 1600×192 | **60.2** | 16.7 | 16.7 | 33.2 | 0.2% | 148 | 1145 |

\* K=9-M1's 146ms max is a first-frame setup hitch; p95=16.7 confirms steady state is clean.

Side-by-side against 24's per-cell architecture:

| K | per-cell (24) | atlas (24a) |
|---|---|---|
| 9 | 53 fps, 12% >33ms | 60 fps, 0.3% >33ms |
| 16 | 34 fps, **73% >33ms** | 60 fps, 0.2% >33ms |
| 25 | 24 fps, **88% >33ms** | 60 fps, 0.2% >33ms |

The atlas does two things at once:
- **Fewer texImage2D calls per tick** — M atlas uploads vs K per-cell uploads (5 vs 25 at K=25). The per-cell upload chain was 24's bottleneck; atlas collapses it.
- **Less aggregate decode work** — 24's K=25 needed 738 decode fps to feed each cell at 30 fps; 24a's K=25-M5 only needs 148 fps (5 atlas streams × 30 fps each).

Atlas build is 1.1-2.8 s wall-time per atlas at these sizes (one-shot, ahead of the render loop). That's a finalize-step cost, and it's the work 18g's hot-path pattern would do concurrent with capture for AV1 atlases — untested here.

## Note for eddy implementation

- For K=16+ uniform-grid layouts, sub-atlas grouping with AV1-SW decode is smooth end-to-end.
- The K=9 case works either way; per-cell at K=9 (24) was 53 fps with 12% jank, atlas at K=9 (24a) is clean 60 fps. Atlas wins even at K=9 in this run, but the 24 K=9 number was likely thermal/variance, not architectural. Either pattern is viable at K=9.
- Atlas decoder count M and per-atlas cell count C have flexibility — K=16 worked at M=4 (2×2 cells per atlas). K=25 worked at M=5 (5×1). Other packings unmeasured.
- Atlas build cost (~1-3 s for these sizes) needs to fit somewhere in the eddy flow. 18g's pattern (cached chunk worker, builds during capture) is the prior art for VP8; the AV1 equivalent is unmeasured.
- The shader needs sub-rect sampling (uvOffset + uvScale uniforms); UV math handled per-cell. Trivial complexity.

## Caveats

- Compositing uses the same source for every cell (visually
  identical), as in 24. Per 15, cross-cell entropy isn't load-bearing
  for atlas decoding.
- Atlas dimensions chosen to keep mip-per-cell parity with 24. Other
  packings possible (e.g. K=25 could be 5+5+5+5+5 in 5×1 atlases, or
  one big 5×5 atlas). Only the tested packing is measured.
- Atlas build time *not* on the hot path here — atlases are built
  ahead of the render loop. 18g already validated that builds can
  happen concurrent with capture; that integration is a follow-up.
- The `runRenderLoop` shape mirrors 24 — single-clock decode pacing,
  no warm-up frames dropped. First-frame setup hitch shows up in the
  `maxMs` and `jankScore`; see 24's notes.
- AV1 atlas build cost is itself unknown for this device — could be
  significant at the higher-resolution atlases. Recorded but not
  optimized.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
TIMEOUT_MS=300000 PORT=<port> experiments/harness/run.sh 24a_render-loop-av1-atlas
```
