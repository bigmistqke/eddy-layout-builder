# atlas-swap

**Question:** when a sub-atlas finishes rebuilding, the cell needs to
hand off from the old atlas (or bitmap series) to the new atlas at the
next loop boundary. How big is the gap at handoff, and can we make it
frame-accurate?

## Why

The flow design (this conversation, not yet written up) does atlas
swaps at loop boundary 0:
- `playing-bitmaps → playing-atlas` (rebuild landed)
- `playing-atlas (v_old) → playing-atlas (v_new)` (layout edit / re-record completed)

[13](../13_cold-start/README.md) found `configure + decode-first-frame`
takes ~130ms from a freshly-configured decoder. If that latency falls
between the last paint of the outgoing source and the first paint of
the incoming atlas, the user sees a ~4-frame blank on every swap. That
breaks "imperceptible handoff."

The fix is to **pre-warm** the new decoder: configure it and decode the
first frame *before* the swap boundary, hold the frame, and at the
boundary just hand off the pointer.

## Setup

1. Bake two atlases from the same source clip (atlas A and atlas B).
2. Start a decode loop on atlas A — models the cell currently in
   `playing-atlas` (or its bitmap-equivalent).
3. **Cold-swap pass.** At time `T_swap`:
   - Configure B's decoder
   - Decode B's first chunk
   - Measure the gap from `T_swap` to when B's first frame is emitted
4. **Hot-swap pass.** Before `T_swap`:
   - Configure B's decoder
   - Decode B's first chunk, hold the resulting `VideoFrame`
   - Hold until `T_swap`
   - At `T_swap`, use the stored frame immediately and continue
     decoding B
   - Measure the gap from `T_swap` to first-frame-available (should
     be ~0ms — the frame is already in hand)

Reports per pass:
- `swapGapMs` — time from "swap triggered" to "first frame ready to paint"
- `frameAlive` (hot pass) — true if the held VideoFrame is still valid
  after the hold

## What to look for

- **Cold swap** ≈ 130ms (matches 13). Confirms the naive path is bad.
- **Hot swap** ≤ ~1ms. Confirms pre-warming makes swap effectively free.
- **Pre-warm cost** (configure + first decode happen ahead of time, not
  at the swap) — known cheap from 13.

If hot swap is sub-frame, the cell renderer in production can simply
hold a "next" decoder + first frame whenever a rebuild lands, and the
swap at the next boundary is a pointer flip.

## Note for eddy implementation

**SUPERSEDED by [16](../16_swap-with-bitmap-hold/README.md).** This
experiment held a `VideoFrame` across a 500ms wait, which worked, but
`VideoFrame`s are GPU-backed and the spec is intentionally vague
about lifetime. 16 redid the test with `ImageBitmap`-hold instead
(durable across 30s) + verified the `VideoDecoder` keeps its internal
state across the same idle. Use 16's pattern in production:

- Pre-warm decoder + decode chunk 0 → `drawImage` to canvas →
  `transferToImageBitmap` → close `VideoFrame` → hold the bitmap
- At swap boundary, paint the bitmap (single `texImage2D`) + feed
  the next chunks; decoder state was retained, so frame 1 decodes
  in ~33ms (see 16's note for the pre-decode-ahead trick)

The 0ms-swap *measurement* here remains correct; only the storage
mechanism for the held frame changes.

## Caveats

- Single source clip tiled into both atlases — they have identical
  bitstreams. A real swap goes between different bitstreams (the user
  changed a cell). Doesn't affect decoder init / first-frame timing.
- Hold time (between pre-warm and swap) is short here (~500ms). In
  production it could be many seconds. Worth a future check that
  long-held `VideoFrame`s don't leak GPU memory or get invalidated.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
PORT=<port> experiments/harness/run.sh 14_atlas-swap
```
