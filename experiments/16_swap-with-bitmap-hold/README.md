# swap-with-bitmap-hold

**Question:** can the 14 atlas-swap pattern be redone with an
`ImageBitmap` instead of a `VideoFrame` for the held first-frame —
surviving 5s / 30s holds — *and* does the `VideoDecoder`'s internal
state survive those holds so the next delta chunk decodes cleanly?

## Why

[14](../14_atlas-swap/README.md) validated the pre-warmed atlas-swap
pattern with a 500ms hold of a `VideoFrame`. But `VideoFrame`s are
GPU-backed and the spec is intentionally vague about lifetime — the
500ms hold worked, but holding one for 30s is hoping rather than
designing.

The flow design's atlas swap happens at the next loop boundary after
rebuild completes. The wait could be ~half a loop pass (15s for a
30s song, longer for slower songs). That's well past 14's tested
holds.

`ImageBitmap` has well-defined CPU-side reference lifetime — 12
held thousands across multi-second runs without issue. If we
substitute bitmap-hold for VideoFrame-hold, we get the same 0ms
pointer-flip swap with predictable storage semantics.

The catch: the held bitmap is only **frame 0**. From frame 1 onward,
the cell needs the `VideoDecoder` to continue decoding. So a second
question: does the decoder's internal state (last-decoded keyframe
reference) survive the same long idle, so `decode(chunk 1)` produces
a valid delta frame?

## Setup

Bake one atlas. For each hold time in `holdMs` (500ms, 5s, 30s):

1. Configure a fresh `VideoDecoder`.
2. Decode `chunks[0]` (keyframe) → receive `VideoFrame` →
   `drawImage` into a small canvas → `transferToImageBitmap` → close
   the VideoFrame → hold the bitmap.
3. Wait `holdMs`. Don't touch the decoder.
4. **Bitmap-hold check.** Paint the held bitmap into an offscreen
   WebGL2 texture (the swap's "first frame after handoff"). Confirm
   the bitmap is still usable.
5. **Decoder-state check.** Call `decoder.decode(chunks[1])` (delta
   chunk, depends on chunk 0's keyframe state). Measure time-to-
   first-frame, verify frame dims are valid.
6. Close everything and proceed to next hold.

Reports per hold:
- `bitmapPaintOk` — did the held bitmap upload without error?
- `decoderStateOk` — did the post-idle delta decode produce a valid
  frame?
- `postIdleDecodeMs` — how long from `decode(chunks[1])` to its
  output? (Expected: small — decoder is hot, just one delta chunk
  to process.)

## What to look for

The production pattern works if **all** holds report:
- `bitmapPaintOk: true`
- `decoderStateOk: true`
- `postIdleDecodeMs` ≤ ~50ms (a single delta-chunk decode)

If `bitmapPaintOk` ever fails: bitmap lifetime is actually bounded
too; need a different scheme (re-decode on swap, accept latency).

If `decoderStateOk` fails at long holds: the decoder forgets its
keyframe state after idle. Fallback: at swap, `reset()` + re-decode
chunk 0 (130ms cold start per 13), mask it with the held bitmap
painting for those first ~4 frames.

If `postIdleDecodeMs` is small but the frame is wrong (e.g. green,
artifacts): more subtle — decoder state was partially retained but
desynced.

## Verdict (2026-05-16 · Galaxy A15 · Android 10 · Chrome 148)

All three checks pass cleanly across every hold:

| hold | bitmapPaint | decoderState | postIdleDecode (chunk 1) |
|---|---|---|---|
| 500ms | ✓ | ✓ | 12.5ms |
| 5s | ✓ | ✓ | 33.3ms |
| 30s | ✓ | ✓ | 33.6ms |

- `ImageBitmap` survives 30s without issue (bitmaps are explicitly
  reference-counted CPU image data — predictable, unlike VideoFrame).
- `VideoDecoder` retains its keyframe state across 30s idle — the
  delta chunk decodes into a valid 544×976 frame.
- Post-idle decode latency grows modestly with hold (12 → 33ms),
  likely decoder caches going cold. 33ms = one frame at 30fps.

**Architecture:** atlas swap is safe and durable with bitmap-hold +
decoder-state-retention. 14's pattern stands but **replaces "hold
VideoFrame" with "hold ImageBitmap"** — same 0ms swap, no spooky
VideoFrame lifetime assumptions.

## Note for eddy implementation

At swap, the cell paints the held bitmap (frame 0) immediately, then
needs frame 1 by the next 30fps tick (~33ms later). If post-idle
`decode(chunks[1])` itself takes ~33ms, frame 1 *just barely* arrives
in time and any extra latency makes it miss.

**Production play:** kick off `decode(chunks[1])` a few ms *before* the
swap boundary — while the old source is still painting frame N-1. The
decoder is in pipeline mode when the swap fires, frame 1 is already
emitted (or close to it), and the second-frame budget is comfortable.

The trick is generally: never let the decoder be cold when you need
its output. Pre-warm sub-chunks ahead of the boundary as well as the
first frame.

## Caveats

- Single source / single atlas — the bitmap-hold question is content-
  independent; if it works for one atlas it works for any.
- Hold times tested are 500ms / 5s / 30s. A 5-min hold (e.g. user
  stops playing for a coffee break, comes back) isn't in scope.
- The "next loop boundary after rebuild" timing in the flow design
  is bounded by song length (~30s for a typical song). 30s should
  cover the realistic worst case.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
PORT=<port> experiments/harness/run.sh 16_swap-with-bitmap-hold
```
