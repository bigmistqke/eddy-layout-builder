# resolution-codec-pool

**Question:** does the cross-codec non-additivity from
[20c](../20c_cross-codec-dual-pool/README.md) flip at lower resolution?
And does single-pool throughput grow enough at small cell sizes that
cross-codec becomes moot?

## Why

20c's verdict: cross-pool (VP9-HW + AV1-SW) gave 459 fps vs predicted
632 — both pools dropped 22-30% under cross load. Most likely shared
bottleneck: **memory bandwidth** (every decoded frame writes ~width ×
height × 4 bytes per frame).

eddy cells aren't typically 720p. A 3-cell layout on a 1080-wide phone
gives each cell ~360×640. At 1/4 the pixels, memory bandwidth pressure
drops 4×. Two questions follow:

1. **Cross-codec at 540p / 360p** — does the additivity gap close?
   If 720p cross-4+4 = 72% of predicted, what's the ratio at 540p?
   At 360p?
2. **Single-pool ceiling per resolution** — does AV1-SW-4 at 540p give
   K=30+ cells alone? If so, multi-codec storage doesn't pay off, but
   multi-resolution storage clearly does.

This is the data we need to decide the storage architecture:
- Single codec, multi-resolution (mip-style ladder)
- Multi-codec, single resolution (today's 20b/20c)
- Multi-codec, multi-resolution (the maximum-flexibility option, but
  worth ~3-4× storage)

## Setup

Record one 720p VP8 source clip. For each resolution × codec:
- Decode source → downscale via canvas → re-encode at target codec +
  resolution. ([harness/transcode.ts](../harness/transcode.ts) pattern,
  parameterized for codec.)
- Yields 6 transcoded assets: {720p, 540p, 360p} × {vp9, av1}.

For each resolution, three passes:
- **vp9-hw-4** — 4 VP9 HW decoders, baseline at this res
- **av1-sw-4** — 4 AV1 SW decoders, baseline at this res
- **cross-4+4** — 4 VP9-HW + 4 AV1-SW concurrent

Each pass 10 s flat-out.

## What's measured

For every (resolution, pass) tuple:
- Aggregate fps
- Per-pool fps split
- Additivity ratio: cross-4+4 / (vp9-hw-4 + av1-sw-4)
- Per-decoder fps drift

## What to look for

- **Additivity ratio rising as res drops** — 720p ~72%, 540p ~85%,
  360p ~95% → confirms memory bandwidth was the bottleneck
- **Single AV1-SW-4 at 540p ≫ 720p** — e.g. 700-900 fps at 540p
  (K=23-30 cells) → simpler one-codec-multi-res strategy is enough
- **Cross-4+4 at 360p approaching additive (~1000+ fps)** → K=33+ cells
  with cross-codec at small res — multi-codec multi-res becomes the
  winning architecture, but probably overkill
- **Surprise**: lower-res *doesn't* help proportionally → the
  bottleneck is elsewhere (main-thread callbacks, browser scheduling).
  In that case [23](../23_sw-workers/README.md)'s worker test
  diagnoses it

## Verdict

**AV1-SW at typical cell resolution is a game-changer; cross-codec actively hurts at lower res.**

| res | vp9-hw-4 | av1-sw-4 | cross-4+4 | additivity |
|---|---|---|---|---|
| 720p | 181 | 456 | 492 | 77% |
| 540p | 211 | **821** | 721 | 70% |
| 360p | 240 | **1690** | 1259 | 65% |

Two surprises:

1. **AV1-SW at lower res is staggering.** 540p → 820 fps (K=27 cells), 360p → 1690 fps (K=56 cells). A single SW pool at typical eddy cell resolution serves more cells than any plausible session needs.

2. **Cross-codec gets *worse* at lower res, not better.** Additivity drops 77% → 70% → 65%. At 540p/360p, cross-4+4 is *worse* than av1-sw-4 alone (721 vs 821; 1259 vs 1690). The memory-bandwidth hypothesis is falsified.

The pattern: as AV1-SW gets faster (more output callbacks/sec), adding VP9-HW hurts more. That points to **main-thread callback saturation** at ~1500-2000 callbacks/sec, not memory bandwidth. Tested directly in [23](../23_sw-workers/README.md).

VP9-HW barely scales with smaller frames (181 → 240, +33% for 4× fewer pixels) — HW path has high per-frame fixed overhead. Another reason cross-codec is a poor architecture for typical eddy cell sizes.

## Note for eddy implementation

- **Pick AV1-SW (with multi-resolution cache) over cross-codec.** Multi-codec storage is not worth it on this device at any tested resolution.
- **Render each cell at its display resolution.** The 360p single-pool result (K=56) only happens because frames decode at 360p. If you decode at 720p and downscale in WebGL, you pay the 720p cost.
- **Storage layout should be a mip-style ladder** per clip: 720p (canonical/portable) + lower resolutions cached locally. A 540p mip costs ~0.6× the 720p bytes; a 360p mip ~0.3×. Total ladder ~2× source.
- **The "atlas required past K=4" finding from 10/11 is fully obsolete on this device** for layouts where cell res ≤ 540p.

## Caveats

- 1280×720 source recording is the only one — re-encoding to 540p and
  360p via canvas adds a downscale tax that real captures wouldn't
  have. The decode throughput should still reflect the right
  resolution though.
- Three resolutions only — 270p / mip-2 versions may be even faster
- AV1 encode at small res is fast (bandwidth-bound rather than
  encode-bound) but worth confirming the transcode itself completes
- VP8 macroblock alignment (mult-of-16) applies to other codecs too;
  uses the same `snap16` from `harness/transcode.ts`
- 10 s per pass × 9 passes × ~6 s transcode each × 6 transcodes
  ≈ 3.5 min total

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
TIMEOUT_MS=600000 PORT=<port> experiments/harness/run.sh 20d_resolution-codec-pool
```
