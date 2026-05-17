# render-loop-hybrid

**Question:** how many concurrent **dirty per-cell streams** can
coexist with a **stable atlas baseline** (M sub-atlases × C cells)
before the rAF tick saturates?

Models the eventually-consistent atlas pattern: cells whose clips
were recently added/changed render from per-cell streams; the rest
sample from atlas sub-rects; an atlas rebuild eventually drains dirty
slots back into the atlas.

## Why

[24](../24_render-loop-av1-multires/README.md) showed per-cell-only
falls off at K≥16. [24a](../24a_render-loop-av1-atlas/README.md)
showed M-atlas + K-sub-rect sampling holds clean 60fps at K=16/25.
Neither validated the **hybrid**: M atlas decoders for steady-state
cells, plus D per-cell decoders for "just-edited" cells, all at once.

If D can be ~5-8 without breaking the rAF tick at the M=4 baseline,
the eventually-consistent atlas architecture is viable: the hot path
of "user added one more clip" doesn't block on atlas rebuild; it just
adds one more per-cell decoder on top of the existing atlas pool.

## Setup

Fix K=16, M=4 (2×2 cells per atlas). Sweep D ∈ {0, 2, 4, 8, 12}:

- **D=0** — pure atlas (= 24a's K16-M4 baseline)
- **D=2** — 14 atlas-sampled cells + 2 dirty streams
- **D=4** — 12 atlas-sampled cells + 4 dirty streams
- **D=8** — 8 atlas-sampled cells + 8 dirty streams (half-and-half)
- **D=12** — 4 atlas-sampled cells + 12 dirty streams (mostly per-cell)

For each pass:
1. Build M=4 atlases up front (same as 24a).
2. Build a 270p AV1 per-cell mip (matches 24's K=16 mip).
3. Spawn M atlas decoders + D per-cell decoders.
4. For the K cells: first D render from their own per-cell stream;
   the remaining (K-D) sample from atlas sub-rects.
5. Render loop drives all M+D decoders from rAF, paints all K cells,
   one `gl.clear` per tick.

10s per pass. JankRecorder + longtask observer per pass.

## What's measured

Per pass:
- Render fps + jank stats (mean/p95/p99/max, over33msRatio,
  longestJankStreak, jankScore)
- Long-tasks observed
- Aggregate decode fps (sum across M atlases + D per-cell decoders)
- Texture upload count per tick (= M + D — informational)

## What to look for

- **D=0..8 stays clean 60fps with <1% over-33ms** → hybrid
  architecture is viable; the eventually-consistent atlas pattern
  works
- **D begins to jank at some threshold (e.g., D=8 or D=12)** →
  marks the practical ceiling for "concurrent recently-edited cells"
  on this device. Sets a UX constraint: rebuild atlases more
  aggressively when dirty count approaches that threshold
- **D=12 (mostly per-cell) collapses to 24's K=16 numbers
  (~34fps, 73% jank)** → confirms 24 wasn't a fluke; atlas dominance
  at K=16 still real
- **Decode fps grows linearly with D** but rAF stays steady → the
  bottleneck is texture upload + draw, not decode (matches 24's
  finding)

## Verdict

**The hybrid works, but the dirty budget is tight: D ≤ 2 clean, D ≥ 8 fails.**

| D | uploads/tick | fps | mean | p95 | >33ms | streak | decode fps |
|---|---|---|---|---|---|---|---|
| 0 | 4 | **60.1** | 16.8 | 16.7 | 0.2% | 1 | 119 |
| 2 | 6 | **59.8** | 16.7 | 16.7 | 0.3% | 1 | 178 |
| 4 | 8 | 55.2 | 18.1 | 33.3 | **8.7%** | 2 | 237 |
| 8 | 12 | 39.3 | 25.5 | 33.4 | **52%** | 5 | 356 |
| 12 | 16 | 30.0 | 33.3 | 50.0 | **83%** | 28 | 474 |

Dominated by texture-uploads-per-tick (= M+D):
- 4-6 uploads → clean 60 fps
- 8 uploads → first wobble (9% over 33 ms)
- 12 uploads → soft failure (52%)
- 16 uploads → matches 24's pure per-cell K=16 collapse

So on this device the smooth `texImage2D`/tick budget is **~6-7 uploads**. At M=4 baseline that gives D ≤ 2-3 dirty cells before perceptible jank starts.

Decode-side scaling is linear and well within the AV1-SW pool (D=12 → 474 fps aggregate, far under solo ceilings) — confirms 24's finding that decode isn't the bottleneck. The texImage2D + drawArrays chain on the rAF tick is.

## Note for eddy implementation

- Eventually-consistent atlas pattern is viable, but the architecture must **bound D** — rebuild atlases before the dirty count exceeds ~3.
- An **incremental rebuild** strategy (rebuild one atlas slot at a time, draining D one cell per rebuild cycle) probably keeps D close to 1 in practice. Unmeasured here.
- For UX: a user adding 3+ clips in rapid succession may see jank on this device unless the rebuild queue stays ahead. Background rebuild scheduling matters more than rebuild *speed*.
- Lower M (say M=2 atlases) widens the D budget (D ≤ 4-5 with M+D ≤ 7). Tradeoff: smaller atlases need more rebuilds when content changes. M=2 vs M=4 vs M=8 hasn't been measured here.

## Caveats

- Same source clip for every cell + every atlas slot, as in 24/24a.
  Per 15, cross-cell entropy isn't load-bearing for atlas decode.
- "Dirty" cells in this experiment always run their per-cell stream
  for the full 10s — no swap-back to atlas mid-run. The atlas-swap
  cost (per 14/16) is a separate question.
- Dirty cells happen to be the *first* D cells in row-major order.
  Doesn't affect rendering cost; mentioned for reproducibility.
- The per-cell mip used by dirty cells matches 24's K=16 mip (270p)
  even though cells are smaller in the K=16 viewport. Slightly
  over-resolved; not the bottleneck.
- Atlas-swap discipline (when a rebuild completes and the cell
  transitions back to atlas sampling) is out of scope here.
- Single layout (uniform 4×4 grid). Container-aligned layouts
  (per 11) add aspect heterogeneity; follow-up.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
TIMEOUT_MS=360000 PORT=<port> experiments/harness/run.sh 24b_render-loop-hybrid
```
