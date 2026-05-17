# upload-primitive-sweep

**Question:** every render-loop experiment so far (24, 24a, 24b, 24c,
24d, 24e) used `gl.texImage2D(...VideoFrame)`, which reallocates
texture storage every frame. **How much of the measured per-tick
upload cost — and the ~7-uploads-per-tick smooth ceiling — was the
wrong primitive? Concretely: how does upload cost vary across
`(source type × upload primitive × resolution × concurrent uploads
per tick)`?**

## Why

`texImage2D` allocates storage each call. The correct primitive for
a dynamically-updated texture of fixed size is:

```js
// Once at texture creation:
gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height)
// Each frame:
gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, source)
```

Empirically the immutable-storage + `texSubImage2D` path is
typically 1.5-3× faster per call on modern stacks; the driver can
keep the storage in a hot path instead of re-validating dimensions
every call.

Separately, the [18c](../18c_opfs-bitmaps/README.md)-inspired
all-in-bitmap design proposal (raw RGBA in OPFS, no codec in active
session) hinges on whether `texImage2D(Uint8Array)` is competitive
with `texImage2D(VideoFrame)`. The VideoFrame path may have a hot
GPU-backed shortcut; the Uint8Array path is "real" CPU→GPU bytes.
Unmeasured to date.

Together these two unknowns set the actual upload budget on this
device. If `texSubImage2D` materially loosens the budget, several
24-series conclusions need to be re-examined under the new
primitive. If the Uint8Array path is competitive, the all-in-bitmap
design has headroom.

## Setup

Pure primitive measurement — no atlas, no decoder, no draw work.
Just upload-and-measure across the full matrix:

| Axis | Values |
|---|---|
| Source type | `VideoFrame` (constructed from RGBA bytes) / `Uint8Array` (raw RGBA) |
| Primitive | `texImage2D` (mutable storage) / `texSubImage2D` (immutable, allocated once via `texStorage2D`) |
| Resolution | 540×304, 360×208, 270×144, 180×112, 144×80 (snap-16 of common cell mips) |
| K (concurrent uploads/tick) | 1, 4, 8, 16 |

= 2 × 2 × 5 × 4 = **80 cells**, each measured over ~2 s of rAF
ticks. Per cell:

- Pre-allocate K textures (with `texStorage2D` for the immutable
  path, without for the mutable path)
- Pre-generate K source data — same Uint8Array bytes for both
  source types (the VideoFrames wrap the same byte arrays)
- Per rAF tick: bind+upload each of K textures, then `gl.finish()`
  to force GPU completion, then record submission time + finish
  time
- Report mean / p95 / max over collected samples

## What's measured (per cell)

- `submitMs` — CPU time for the K `texImage2D`/`texSubImage2D`
  calls (without `finish`). What the render loop actually pays
  before yielding to the GPU.
- `finishMs` — additional time `gl.finish()` blocked for the GPU
  to catch up. Together with `submitMs`, the true per-tick upload
  cost.
- `totalMs` = `submitMs + finishMs`. Primary headline. Must be ≤
  16.7 ms for sustained 60 fps.
- All three reported as mean / p95 / max with sample count.

## What to look for

- **`texSubImage2D` (immutable) materially faster than `texImage2D`**
  at high K → all 24-series upload budgets were measured
  pessimistically; real ceiling is higher.
- **`Uint8Array` upload competitive with `VideoFrame` upload** → the
  all-in-bitmap design has no hidden upload penalty.
- **`totalMs` scales linearly with K** (e.g., K=8 totalMs ≈ 8 × K=1
  totalMs) → per-call cost dominates; smaller K helps less than
  smaller resolution.
- **`totalMs` scales linearly with `width × height`** within a fixed
  K → per-pixel cost dominates; the "smaller mips → bigger upload
  budget" hypothesis from 24-series discussion holds.
- **`Uint8Array texImage2D` >> `VideoFrame texImage2D`** → the
  VideoFrame path has GPU-side optimizations not available to
  raw-bytes uploads; the all-in-bitmap design pays for this.
- **`Uint8Array texSubImage2D` ≈ or faster than `VideoFrame
  texImage2D`** → the bitmap path wins outright once the right
  primitive is used.

## Caveats

- This is upload-only. No `drawArrays`, no `gl.clear`. The actual
  render loop also has draw cost (small per call but non-zero) and
  per-tick overhead.
- `gl.finish()` is a stronger sync than production needs. Real
  render loops pipeline GPU work across frames; `submitMs` is what
  the rAF callback actually spends, `totalMs` is the upper bound.
- Source `VideoFrame`s are constructed from RGBA bytes via the
  `new VideoFrame(buffer, { format: "RGBA", ... })` path — they
  don't have the GPU-backed shortcut a decoded-from-codec
  VideoFrame might have. A separate decode-path test could compare
  this to "real" VideoFrames from a `VideoDecoder`. Out of scope
  here; flag as follow-up.
- No concurrent decoder work; the GPU process is otherwise idle.
  Real render loops have decoders running. Upload contention with
  active decoders is a separate question — but unlikely to change
  the relative ordering between the four (source × primitive)
  combinations.
- Resolutions snap to multiples of 16 on the width and 8 on the
  height for VideoFrame compatibility.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
TIMEOUT_MS=360000 PORT=<port> experiments/harness/run.sh 25_upload-primitive-sweep
```
