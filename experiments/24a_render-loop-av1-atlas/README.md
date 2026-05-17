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
