# grid-streaming

**Question:** does the *real* streaming workload sustain realtime? — N
cells that together fill one ~viewport-sized image (each cell ≈
viewport/√N), all decoded concurrently.

This is the **naive first attempt** — it records each cell directly from
the camera. It turned out the camera won't cooperate (see Verdict); the
corrected version is [04_grid-streaming-transcoded](../04_grid-streaming-transcoded/README.md).

## Why

[02_decoder-pools](../02_decoder-pools/README.md) ran K decoders each on
a full 720p stream and found sub-linear scaling — but that's not the
product's workload. The real grid is **one ~viewport image subdivided
into N cells**: each cell is ~viewport/√N per axis, and total decoded
pixels stay roughly constant as N grows.

That isolates the question decoder-pools left open:

- If the bottleneck is **per-stream overhead** (a fixed cost per decoder
  instance), N small streams are still bad → the composite (one decode)
  wins.
- If it's **pixel bandwidth** (∝ total pixels), N small streams summing
  to a viewport are fine → streaming works.

## Setup

`totalResolution` = the A15's screen (~1080×1965 device px). For each N
in `gridSizes` (4, 9, 16, 25 — square grids), records a clip at the cell
size (`total / √N` per axis) directly from the camera, runs N decoders
looping it concurrently for `runSeconds`, and reports per-decoder
sustained fps, min, aggregate, and `realtimeOk` (min ≥ 28).

## Verdict (2026-05-14 · Galaxy A15 · Android 10 · Chrome 148)

**The camera ignores requested cell resolutions** — it clamps to its
discrete sensor modes. Two runs (original + a reproducibility re-run)
agree closely:

| N | requested cell | actual | min fps (run 1 / run 2) | realtime? |
|---|---|---|---|---|
| 4 | 540×983 | 1088×598 | 34.3 / 33.6 | ✅ |
| 9 | 360×655 | 720×396 | 19.6 / 21.3 | ❌ |
| 16 | 270×491 | 720×396 *(same as N=9!)* | 12.6 / 12.1 | ❌ |
| 25 | 216×393 | 480×264 | 17.6 / 17.5 | ❌ |

- **Results reproduce** within run-to-run noise — the harness is
  reliable.
- But "cell = viewport/√N" never took effect: **N=9 and N=16 ran the
  identical 720×396 clip**, so the cross-N comparison is confounded.
- What still holds: only **N=4** sustained realtime; the clean N=9-vs-16
  pair (same clip) shows more decoders → lower per-decoder fps, neither
  realtime.

**Conclusion:** a streaming pipeline cannot get small per-cell clips
from the camera — it must **downscale after capture**. That's not a
workaround, it's a real pipeline step (and cost). Continued, correctly,
in [04_grid-streaming-transcoded](../04_grid-streaming-transcoded/README.md).

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
PORT=<port> experiments/harness/run.sh 03_grid-streaming
```
