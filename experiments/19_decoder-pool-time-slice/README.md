# decoder-pool-time-slice

**Question:** can a single `VideoDecoder` serve multiple cells at
realtime by *time-slicing* — decoding a batch of frames into one
cell's ring buffer, then switching to the next cell, then back?
If yes, the 4-decoder hardware cap (per 04/06) stops being a wall —
K cells can scale beyond the decoder count.

## Why

- One decoder at 720p sustains **~85 fps** (per 01_raw-capability)
  — ~2.8× realtime headroom
- Reconfigure cost is **~80 ms at 720p** — too expensive per frame,
  cheap when amortised over a batch of N frames
- With batch size N=30 (1 s of source): effective throughput per
  decoder ≈ 30 / (0.08 + 30 × 0.012) = **~68 fps source-content** =
  **~2 cells per decoder** at realtime
- 4 decoders × 2 cells each = K=8 cells supported via time-slicing,
  without any atlas
- Bonus: keeps decoders busy → sidesteps Chrome's idle-reclamation
  (W3C WebCodecs issue #424 surfaced in prior-art research)

This experiment tests v1: **one** decoder, K cells from the same
source, batched switches, per-cell ring buffers, render at 30fps.

## Setup

1. Record one source clip.
2. Create K "virtual cells", each backed by the same source. Each
   cell has its own ring buffer of pre-decoded `VideoFrame`s and a
   cursor for what the renderer has consumed.
3. Spawn ONE `VideoDecoder`. Output handler routes each emitted
   frame to the "currently active" cell's ring buffer.
4. **Scheduler loop** (async): rotate through cells; for each one,
   if its ring buffer is below threshold, `reset() + configure() +
   decode batch of M chunks` to refill it.
5. **Render loop** (rAF): for each cell, advance cursor by elapsed
   time, paint current ring-buffer frame into the cell's screen rect.
   If buffer is empty, paint the last frame and count an underflow.

## What's measured

- `switchMs` per switch (reset + configure + first-frame-out time)
- `batchMs` per batch (full M-frame decode + flush)
- `effectiveFpsPerDecoder` (total frames produced ÷ run-seconds)
- Per-cell `framesRendered`, `underflows`, `cellRenderFps`
- Whole-system render jank (full `JankReport` per `harness/jank.ts`)

Three passes:
- K=2 cells (light test, should work easily)
- K=4 cells (matches streaming wall from 04 — interesting boundary)
- K=8 cells (the production target if this works)

Per pass: batch size M=30 (1 s of source frames). Run ~6 s.

## What to look for

- **`switchMs` ≈ 80 ms** matches 01's reconfigure cost → math holds
- **`switchMs` ≪ 80 ms** (e.g. ~5 ms) → time-slicing is even cheaper
  than expected, the math underestimates
- **No underflows at K=2, K=4** → time-slicing works at those K
- **K=8 underflows** = the practical wall for this batch size; need
  bigger batch or more decoders
- **Whole-system render jank low** → time-slicing doesn't introduce
  visible stutter in the render path

## What this experiment does NOT do (v1 scope)

- Each cell loops the same M-frame window (`chunks[0..M]`) of its
  source. True seeking to arbitrary positions requires keyframe
  alignment; skipped for v1.
- One decoder only. Scaling to 4 decoders × N cells each is a
  follow-up (19b).
- Sources are all recorded with the same camera params, so their
  decoder configs match — `configure()` after `reset()` is real but
  doesn't trigger a hardware reconfigure beyond resetting internal
  state. Sources with truly different configs (different codecs,
  dimensions) would cost more per switch; not measured here.

## Caveats

- Reconfigure timing on Android Chrome 148 may differ from 01's
  measurement; the experiment will surface it.
- Ring buffer of 30 `VideoFrame`s per cell — `VideoFrame` GPU
  memory budget might bite at high K. Per 16, ImageBitmap-hold is
  safer for long-held frames; for this experiment short-held in a
  ring buffer should be fine.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
TIMEOUT_MS=600000 PORT=<port> experiments/harness/run.sh 19_decoder-pool-time-slice
```
