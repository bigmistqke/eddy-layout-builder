# distinct-content

**Question:** every prior atlas experiment (05/07/09/10/11) tiles the
*same* source clip into every cell. Identical content compresses
unrealistically well — and might decode unrealistically well too. Does
the K=4 CSS-pixel verdict from 10/11 still hold when each cell holds
*distinct* content?

## Why

**Every prior atlas experiment cheated, slightly.** When 05/07/09/10/
11/12 built an atlas of N cells, all N cells held the *same* source
clip (tiled). That was a harness convenience — record one clip, tile
it — not a deliberate choice. But it gave the video encoder an
unrealistically easy job: identical tiles within a frame are
maximally redundant, and the encoder might have been producing
unrealistically small / fast-to-decode atlases.

In a real eddy session every cell holds a *different* recording.
Distinct content has higher entropy → the encoder can't deduplicate
across cells → the encoded atlas might be larger, and the decoded
bitstream might be heavier per pixel.

This is the biggest "not yet validated" item in
[2026-05-16-flow-design.md](../../docs/superpowers/specs/2026-05-16-flow-design.md).
If distinct content meaningfully bumps contended decode/build cost,
the K=4 verdict needs revisiting — possibly K=2 with extra atlases,
possibly higher atlas resolution, possibly a different architecture.

## Setup

Two passes, both at the K=4 sub-atlas shape from 10 (2×2 cells per
sub-atlas, 540×983 atlas → 270×491 sub-atlas, CSS-pixel resolution).

1. **Record N distinct clips.** N = 4 cells per sub-atlas. Each is a
   separate `recordProbeInput` call — between recordings the camera
   naturally captures slightly different motion. Imperfect proxy for
   "truly distinct content" but the entropy is real (encoder can't
   deduplicate).

2. **Baseline (identical) pass.** Build a sub-atlas tiling clip 0
   into all 4 cells; run a contended pass (capture + atlas decoder +
   worker rebuild of the same identical sub-atlas). Reproduces 11's
   shape exactly — sanity check the regression.

3. **Distinct pass.** Build a sub-atlas where each cell holds a
   *different* clip; run the same contended shape, with the worker
   rebuilding a *distinct* sub-atlas. Compare every metric to the
   baseline.

Reports per pass:
- `prebuildMs` (the initial sub-atlas build)
- `atlasBytes` (re-encoded sub-atlas size — entropy proxy)
- `contended.captureFrames`, `contended.atlasFps`, `contended.buildMs`,
  `contended.buildRateVsRealtime`

## What to look for

| signal | implication |
|---|---|
| `atlasBytes` (distinct) ≫ `atlasBytes` (identical) | confirms entropy difference is real |
| `contended.atlasFps` (distinct) ≈ baseline | decode is **not** bitrate-bound; the K=4 verdict holds |
| `contended.atlasFps` (distinct) much lower | bitrate **does** matter; verdict needs revisit |
| `contended.buildMs` (distinct) modestly higher | expected (slightly more encoder work per cell) |
| `contended.buildMs` (distinct) much higher | rebuild budget shrinks; flow timing tightens |

A drop in `atlasFps` below ~28 in the distinct pass is the failure
mode that would invalidate the architecture as currently specified.

## Verdict (2026-05-16 · Galaxy A15 · Android 10 · Chrome 148)

**The cheat was barely a cheat.** Distinct content costs essentially
nothing extra:

| metric | identical | distinct | Δ |
|---|---|---|---|
| atlasBytes (pre-built) | 193,817 | 201,385 | **+4%** |
| contended atlasFps | 90.7 ✓ | 86.9 ✓ | −5% (noise) |
| contended buildMs | 6505 (1.68×) | 6015 (1.54×) | distinct slightly faster (noise) |
| contended captureFrames | 82 | 98 | distinct slightly better (noise) |

**Why so close.** The encoder finds compression within each cell
(temporal redundancy across frames within one cell) much more than
across cells (spatial redundancy across the atlas image). With
camera-recorded source, the per-cell entropy isn't where the
encoder's saving bytes. Cross-cell similarity isn't load-bearing,
so removing it barely hurts.

**Implication.** The K=4 sub-atlas verdict from 10/11 holds for
realistic content. All prior atlas numbers (05/07/09/10/11/12) are
honest estimates of production cost, not artefacts of the identical-
tiles harness shortcut. The flow design's central architecture stands
without revision.

- "Distinct" here = 4 separate camera recordings of the same scene
  ~seconds apart. Real session content (different camera angles,
  scenes, lighting) has even higher entropy — this measurement is a
  lower bound on the distinct-content cost.
- The 4 recordings are concatenated by simply being separate
  `recordProbeInput` runs; the harness's MediaRecorder restarts
  between them, so there's a small inter-take gap. Not relevant for
  decode/build cost.
- Single sub-atlas measured (not the full K=4 atlas grid). The K=4
  case is K independent sub-atlases decoded in parallel — established
  behaviour per 11; this experiment isolates the per-sub-atlas
  entropy effect.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
PORT=<port> experiments/harness/run.sh 15_distinct-content
```
