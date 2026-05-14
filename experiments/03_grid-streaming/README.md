# grid-streaming

**Question:** does the *real* streaming workload sustain realtime? — N
cells that together fill one ~viewport-sized image (each cell ≈
viewport/N), all decoded concurrently.

## Why

[decoder-pools](../decoder-pools/README.md) ran K decoders each on a
full 720p stream and found sub-linear scaling — but that's not the
product's workload. The real grid is **one ~viewport image subdivided
into N cells**: each cell is ~viewport/√N per axis, and total decoded
pixels stay roughly constant as N grows.

That isolates the question decoder-pools left open:

- If the bottleneck is **per-stream overhead** (a fixed cost per decoder
  instance), N small streams are still bad → the composite (one decode)
  wins.
- If it's **pixel bandwidth** (∝ total pixels), N small streams summing
  to a viewport are fine → streaming works, and the composite is
  unnecessary.

## Setup

`totalResolution` = the A15's screen (~1080×1965 device px). For each N
in `gridSizes` (4, 9, 16, 25 — square grids), records a clip at the cell
size (`total / √N` per axis), runs N decoders looping it concurrently
for `runSeconds`, and reports per-decoder sustained fps, the min, the
aggregate, and whether the slowest held `realtimeFps` (28).

**Read it as:** if `minFps` stays ≥ ~30 as N grows, streaming an N-cell
grid is bandwidth-bound and viable. If it falls off well before the
pixel budget says it should, per-stream overhead is the wall.

To vary, edit `params` in `index.ts` and commit.

## Verdict (2026-05-14 · Galaxy A15 · Android 10 · Chrome 148)

**Partly inconclusive — the experiment has a flaw.** `getUserMedia`
ignored the requested cell resolutions and clamped to the camera's
discrete sensor modes:

| N | requested cell | actual | min fps | realtime? |
|---|---|---|---|---|
| 4 | 540×983 | 1088×598 | 34.3 | ✅ |
| 9 | 360×655 | 720×396 | 19.6 | ❌ |
| 16 | 270×491 | 720×396 *(same as N=9)* | 12.6 | ❌ |
| 25 | 216×393 | 480×264 | 17.6 | ❌ |

So "cell = viewport/√N" never took effect — N=9 and N=16 ran the
*identical* clip. The cross-N comparison is confounded by resolution.

**What's still valid:**

- **N=9 vs N=16 is a clean pair** (same 720×396 clip): 9 concurrent
  decoders → 19.6 fps min; 16 → 12.6 fps min. More decoders, less
  per-decoder throughput, **neither realtime**.
- Only **N=4** (largest cells, fewest decoders) sustained 30 fps.
- Aggregate fps rises with N (143 → 197 → 250 → 440) but **sub-linearly
  vs the N×30 needed** — N=25 needs 750 fps aggregate, got 440.

**The real lesson:** a streaming pipeline cannot get small per-cell
clips from the camera — it **must downscale after capture**. The
experiment needs a downscale step (decode → draw to a smaller canvas →
re-encode), which also measures that downscale cost — itself a real
pipeline cost. **Re-run with that step before trusting any cross-N
conclusion.**

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
PORT=<port> experiments/harness/run.sh 03_grid-streaming
```
