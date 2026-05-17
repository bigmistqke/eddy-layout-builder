# C2 Prototype — Phase 1 Design

**Date:** 2026-05-17
**Status:** phase 1 complete
**Related:** [video pipeline experiments review](2026-05-17-video-pipeline-experiments-review.md)

## Scope

First slice of porting the existing `src/` video layer to the **C2 architecture** (raw RGBA bitmap pipeline, AV1 canonical storage, OPFS working cache) validated end-to-end by experiments 24f-h, 26b, 27, 28, 29.

Phase 1 is the narrowest slice that proves the new contract works against the existing UI and state. It does NOT yet add OPFS persistence (phase 2), AV1 canonical (phase 3), or transport polish (phase 4). It does establish:

- A new `BitmapSource` contract that replaces `VideoSource`
- A `latestFrame()` model that replaces `frameAt(tMicros)`
- A raw-RGBA-only render path replacing the multi-source `TextureSource` union

After phase 1, the app should still record, play, loop, and persist projects identically — just through the new contract — with no functional regression.

## What stays the same

- `Clip` interface shape (`cellId`, `duration`, `audio`, `video`, `input`)
- `ClipStore` (reactive clip map, per-cell volumes)
- `Transport` (audio-driven scheduling, loops, volume routing)
- `OPFS storage layout` (manifests + WebM blobs — phase 3 replaces this)
- `Preview` (live camera source)
- All UI components, HUD, layout-builder, state

## What changes

### 1. `VideoSource` → `BitmapSource`

`src/media/video-decoder.ts` (or new `src/media/bitmap-source.ts`):

```ts
export interface BitmapSource {
  /** The most recently advanced-to frame, or null before the first
   *  frame is ready. Returns a reference into an internal buffer —
   *  callers must consume it within the same tick. */
  latestFrame(): { bytes: Uint8Array; width: number; height: number } | null
  /** Advance the internal cursor to the frame nearest to tSeconds.
   *  Called from the render loop or transport tick. Idempotent for
   *  the same tSeconds. */
  seek(tSeconds: number): void
  /** Reset to the start of the clip — pre-loop hook. */
  reset(): void
  close(): void
}
```

`makeBitmapSource(track: InputVideoTrack)`: decodes the track into a raw-RGBA frame buffer in memory (phase 1 keeps it in memory; phase 2 swaps to OPFS-backed reader worker without changing the interface). Uses `VideoFrame.copyTo({format: 'RGBA'})` per 26b's verdict — no canvas roundtrip.

### 2. Renderer: raw-RGBA-only

`src/webgl/renderer.ts`:

- Replace `TextureSource = VideoFrame | HTMLVideoElement | ImageBitmap | HTMLCanvasElement` union with `{ bytes: Uint8Array; width: number; height: number }`.
- `render(viewport, leaves, frames)` receives a `Map<cellId, BitmapFrame | null>` where `BitmapFrame = { bytes, width, height }`. Null cells skip their draw.
- `texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes)` per cell per tick.
- The shader stays the same; only the upload primitive changes.

### 3. Live camera path

`Preview` returns an `HTMLVideoElement`. The renderer no longer accepts it directly. Phase 1 wraps the live camera in a `BitmapSource`-like adapter:

```ts
export function makeCameraBitmapSource(stream: MediaStream): BitmapSource
```

This uses `MediaStreamTrackProcessor` to pull `VideoFrame`s, `copyTo({format: 'RGBA'})` to a single ring-buffered `Uint8Array`, exposes `latestFrame()` per the contract. The Preview's existing `HTMLVideoElement` stays for the camera autoplay/permission machinery but isn't fed to the renderer.

### 4. Transport drives `seek`

`src/clips/transport.ts`:

- Adds a `bitmapSources(): Map<cellId, BitmapSource>` setter so the transport knows which BitmapSources to advance.
- On each rAF tick (or via a render-loop callback), the transport calls `source.seek(position())` for each cell.
- Loop boundaries call `source.reset()`.

This makes the transport the single clock for both audio and video, matching the existing intent (audio drives, video looks up).

## Out of scope (phase 2+)

- OPFS-backed bitmap storage (phase 2)
- AV1 canonical encode/decode + save/load workers (phase 3)
- Worker-side BitmapSource (currently runs decode in main; phase 2 moves to a worker)
- Capture-to-OPFS writer (still goes through MediaRecorder → demux → in-memory bitmap for phase 1)
- Cold-start on load (no OPFS yet)
- texImage2D upload-primitive optimisations (texSubImage2D, etc — per 25 these don't help on this device; revisit only if needed)

## Touch surface

Approximate scope of the change:

| File | Action |
|---|---|
| `src/media/video-decoder.ts` | Replace impl: VideoSource → BitmapSource, RGBA bytes via copyTo, no ImageBitmap |
| `src/media/bitmap-source.ts` | New: `makeBitmapSource(track)` + `makeCameraBitmapSource(stream)` |
| `src/webgl/renderer.ts` | TextureSource union → raw RGBA only, texImage2D path |
| `src/clips/clip.ts` | Update `video: VideoSource` → `video: BitmapSource`; same lifecycle |
| `src/clips/transport.ts` | Add bitmap-source registry + `seek()` call per tick |
| `src/clips/preview.ts` | Add `BitmapSource` adapter on stream; keep HTMLVideoElement for permission |
| Consumers (renderer call sites) | Read `latestFrame()` not `frameAt()`; route through transport's tick |

Order: BitmapSource impl → renderer change → clip.ts + transport seek wiring → camera adapter → smoke test.

## Success criteria

- App records a cell, plays the cell, loops correctly — visually identical to today
- Multi-cell session (3-9 cells) plays smoothly at 60 fps
- Live camera preview shows in its cell during recording
- Project save / load (existing WebM-blob mechanism) still works — clips re-load and play
- No memory regression vs current (still pre-decodes in-memory; identical bound)
- Code clean enough to drop OPFS reader worker into BitmapSource in phase 2 without touching consumers

## Risks

- **Live camera adapter** is the part that doesn't have a direct experiment precedent. 18c captured raw bitmaps from MediaStreamTrackProcessor; needs verifying the adapter performs the same on real device.
- **Transport timing under load**: the existing transport relies on audio currentTime for `position()`. Adding per-tick `seek()` calls for K video sources adds main-thread work; should be sub-millisecond per call but the integration may need a render-loop callback (rAF-driven) rather than a Transport-driven loop.
- **Multi-cell upload budget**: at K=4-9 layouts the budget is comfortable (per 24f); at higher K the renderer's per-tick `texImage2D` count needs to align with 24f's findings. Phase 1 doesn't add atlas grouping; high-K layouts may need it back in phase 2+.
