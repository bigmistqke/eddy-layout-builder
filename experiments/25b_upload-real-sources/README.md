# upload-real-sources

**Question:** [25](../25_upload-primitive-sweep/README.md) measured
upload cost with *synthetic* VideoFrames (constructed from
`Uint8Array` via `new VideoFrame(buffer, {format:"RGBA", ...})`).
Those have no GPU backing and aren't representative of the
VideoFrames eddy actually uploads. **How do upload costs for the
three real-world sources compare: Uint8Array (OPFS-bitmap path),
camera VideoFrame (live cell), and decoded VideoFrame from
VideoDecoder (atlas / per-cell stream cells)?**

## Why

25's "VideoFrame slower than Uint8Array" finding can't be right for
decoded frames — if it were, [24a](../24a_render-loop-av1-atlas/README.md)'s
atlas-K=16 would have failed (it measured upload-dominated 16.7ms
budget but ran clean 60fps with decoded VideoFrames). The synthetic
VideoFrame is just a Uint8Array wrapper with no fast path, so it
measured "raw bytes + wrapper overhead" rather than the actual
hot-path frames produced by camera or decoder.

The architecturally-load-bearing comparison is:

- **Uint8Array** → models the OPFS bitmap-stream design (18c re-discovery)
- **Camera VideoFrame** → models live-cell upload (`MediaStreamTrackProcessor`)
- **Decoded VideoFrame** → models atlas + AV1 per-cell stream cells

The relative ordering of these three on this device determines the
upload economics of every design path on the table:

- If decoded VideoFrame ≪ Uint8Array → AV1-decode-and-upload wins; atlas designs have headroom Uint8Array doesn't
- If decoded VideoFrame ≈ Uint8Array → no upload-cost reason to prefer one over the other; pick on storage/contention grounds
- If decoded VideoFrame ≫ Uint8Array (the synthetic-25 finding) → bitmap path wins on upload too; atlas designs penalised
- Camera frame upload cost separately informs how cheaply the live-cell can render

## Setup

Same pure-upload-measurement shape as 25 — no draws, no clears, no
atlas, no playback. Per cell: `bind → upload → bind → upload → ... →
finish → record`.

Three sources:

- **Uint8Array** — pre-allocated K RGBA buffers (same as 25).
- **Decoded VideoFrame** — recorded source transcoded to AV1 at the
  target mip. K independent `VideoDecoder`s (prefer-software,
  matching 20d/24-series) running flat-out, ring-buffered to hold the
  latest frame per slot.
- **Camera VideoFrame** — one `getUserMedia` stream →
  `MediaStreamTrackProcessor.readable` reader feeding a K-frame ring
  buffer. Camera is at its native resolution (not under our control);
  resolution sweep doesn't apply.

Matrix:

| Source | Resolution sweep | K sweep |
|---|---|---|
| Uint8Array | 540p / 360p / 270p / 180p / 144p | 1 / 4 / 8 / 16 |
| Decoded VideoFrame | 540p / 360p / 270p / 180p / 144p | 1 / 4 / 8 / 16 |
| Camera VideoFrame | native (typically 1280×720) | 1 / 4 / 8 / 16 |

= 20 + 20 + 4 = **44 cells**, each ~2 s. Total ~90 s of measurement
plus ~30 s of setup (record + 5 mip transcodes + camera open).

Per cell: pre-allocate K textures, pre-build K source slots, briefly
wait for frames to arrive, then run the upload loop. Measure
`submitMs` (CPU upload submission) + `finishMs` (`gl.finish()` GPU
sync wait) → `totalMs`.

## What's measured (per cell)

- `submitMs`, `finishMs`, `totalMs` — mean / p95 / max with sample
  count (mirrors 25)
- `framesReady` — for VideoFrame sources, how many of the K slots had
  a frame available at run start (sanity check that the source
  pipeline is feeding)

## What to look for

- **Decoded VideoFrame much faster than synthetic VideoFrame at the
  same (res, K)** → confirms the fast-path hypothesis and explains
  24a's clean 60 fps. The synthetic-25 number was a wrapper artifact.
- **Decoded VideoFrame ≈ Uint8Array** → upload cost is similar
  enough that the design choice is driven by other factors (storage,
  contention, complexity), not upload economics.
- **Decoded VideoFrame ≫ Uint8Array** → atlas/AV1 designs have a
  real upload tax the bitmap path avoids. Counterintuitive but
  possible if `texImage2D(VideoFrame)` has a YUV→RGBA conversion
  step the Uint8Array path skips.
- **Camera VideoFrame upload cost ≈ decoded VideoFrame** → live
  cells render at the same upload price as other cells.
- **Per-pixel scaling holds across all three** → confirms 24's
  per-pixel upload model independent of source type.

## Verdict

**Upload cost ordering depends on K. Decoded VideoFrame wins at low count; Uint8Array wins at high count. Crossover ~K=4-8.**

| 270p | K=1 | K=4 | K=8 | K=16 |
|---|---|---|---|---|
| Uint8Array | 0.79 | 1.63 | 2.44 | **4.09** |
| Decoded VideoFrame | **0.42** | 1.48 | 3.49 | 9.09 |
| decoded / uint8 | 0.54× | 0.91× | 1.43× | **2.22×** |

At K=16/540p the decoded path costs 2.6× the bytes path (57 ms vs 22 ms — both over budget).

**Likely cause of the inverted scaling:** decoded VideoFrames carry a GPU buffer reference. Uploading K of them concurrently means K GPU buffers fighting for upload IPC slots (same kind of GPU-process contention 23 identified). Uint8Array uploads come from CPU memory through a different pipeline that parallelises better.

**This explains every previous result on this device:**

| Prior finding | Why |
|---|---|
| 24a atlas-K=16 clean 60 fps | M=4 decoded uploads at 270p ≈ 1.48 ms — fast path with massive headroom |
| 24 per-cell K=16 collapsed | 16 decoded uploads at 270p ≈ 9 ms + draws + feed + capture → over 16.7 ms |
| 25 "VideoFrame slower than Uint8Array" | Synthetic VideoFrame is a wrapper over RGBA — no GPU backing, no fast path. Real decoded frames have it. |
| 24b D ≤ 2-3 dirty budget | Dirty cells were decoded VideoFrames — pay the high-K scaling penalty. With Uint8Array dirty cells the budget likely widens. |

**Camera VideoFrames** (720×1280, native): K=1 = 1.45 ms, K=16 = 24.18 ms. Roughly comparable to decoded VideoFrames per upload at similar pixel area. Note the ring buffer only ever held 2 camera frames during high-K measurements, so the K=16 number is "16 uploads of 2 frames cycled," not 16 different frames — slight underestimate of true cost.

## Note for eddy implementation

- **Atlas decoders (M small, fewer textures per tick) should stay on the decoded-VideoFrame path** — it's the fastest source at M=1-4.
- **Dirty / per-cell streams at high D should use the Uint8Array (OPFS bitmap) path** — better scaling at high upload count.
- **The hybrid pattern is genuinely optimal** — each side picks the source type that scales best at its count. M=2-4 atlas decoded + D=4-6 bitmap streams stays well in budget.
- **The 24b "D ≤ 2-3" finding is a lower bound** specific to the AV1-decoded path. Re-measuring 24b with bitmap dirty cells is the natural next step — likely doubles the dirty-cell budget.
- **For large cells (e.g. K=1-2 layouts where a cell is 540p+)** both paths get expensive; this isn't a source-selection problem, it's a "the cell is just big" problem.

## Caveats

- Camera native resolution isn't user-controllable; results at that
  one resolution don't extrapolate to other res points the way the
  decoder/Uint8Array sweeps do. Treated as one anchor data point.
- AV1 decoder failures are possible at very small mips (144p edge);
  pass marked failed if `framesReady === 0`.
- K decoders × 5 resolutions runs ≤ 16 concurrent AV1-SW decoders;
  per 20d that's well within the SW pool's ceiling at small mips.
- This is upload-only, no draws / clears. Real render loops add small
  per-cell draw cost on top.
- `gl.finish()` per tick measures total upload cost (CPU submission
  + GPU completion). In a real loop the GPU work pipelines across
  ticks; `submitMs` is what the rAF callback actually pays.
- Camera stream lives for the entire experiment run; closed at the
  end. Requires camera permission already granted.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
TIMEOUT_MS=420000 PORT=<port> experiments/harness/run.sh 25b_upload-real-sources
```
