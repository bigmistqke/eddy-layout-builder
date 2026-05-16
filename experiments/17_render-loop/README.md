# render-loop

**Question:** every previous experiment measured a *component* fps —
decoder, paint, build, capture — in isolation. The user-visible fps is
something else: the rAF-driven render loop that pulls together atlas
decoders, per-cell texture sampling, WebGL draws, and presentation,
all in one frame budget. What fps does that loop hit on the A15 under
the production hot-path (full layout + capture + worker rebuild)?

## Why

The flow design assumes the renderer can sustain 30+ fps in the
common case. Every component number we have is an upper bound:

| component | best-case number | source |
|---|---|---|
| atlas decode | 75-90 fps | 11 / 15 |
| bitmap paint | 200 fps | 12 |
| capture | 30 fps | 12b |
| worker rebuild | 1.13× realtime | 11 |

The renderer combines all of these *per frame*. If frame time spills
past 16ms (60fps budget) or 33ms (30fps budget), the user sees jank
even though every component is "fine" in isolation. We need the
combined number.

## Setup

The production hot-path during recording:

1. **Record** a source clip.
2. **Bake K=4 sub-atlases** (each holds 4 cells from the source,
   tiled identically — entropy is content-independent per 15). Layout
   = N=16 cells.
3. **Start K continuous atlas decoders**, each looping its atlas,
   exposing a `latestFrame` accessor.
4. **Create a viewport-sized `<canvas>`** in the page, get a WebGL2
   context, compile a shader that samples a sub-rect of a texture and
   draws a quad at the cell's screen rect.
5. **rAF-driven render loop:**
   - For each atlas: `texImage2D(latestFrame)` (one upload per atlas)
   - For each cell: bind atlas texture, set sub-rect UV uniforms,
     `drawArrays` for the cell's screen rect
   - `gl.finish` (force GPU sync so timing is honest)
   - Count frame, record `frameTimeMs` (start of frame → end of finish)
6. Concurrently: **camera capture** (MediaRecorder) + **worker
   rebuild** of one sub-atlas (per 11).
7. Run for `runSeconds`.

Reports:
- `renderedFps` — rAF deliveries actually completed per second
- `meanFrameTimeMs`, `p95FrameTimeMs`, `maxFrameTimeMs`
- `framesUnder16ms` / `framesUnder33ms` — what fraction hit each
  budget
- `captureFrames` (post-demux of MediaRecorder blob)
- `rebuildMs`, `rebuildRateVsRealtime`

## What to look for

- **`renderedFps` ≥ 30** with **p95FrameTimeMs ≤ 33ms** → the
  renderer holds 30fps under contention with margin
- **`framesUnder16ms` ≥ ~95%** → 60fps is achievable; the architecture
  has headroom for nicer transitions / smoother motion
- **p95 well below max** → no occasional jank stalls
- Capture frames and rebuild numbers should match 11's baselines —
  this experiment is about the *renderer's* slot in the hot-path,
  not regressing the others

## Verdict (2026-05-16 · Galaxy A15 · Android 10 · Chrome 148)

| signal | value |
|---|---|
| `renderedFps` | **20.2** ❌ (target 30+) |
| `meanFrameTimeMs` | 6.3 |
| `p95FrameTimeMs` | 15.3 |
| `maxFrameTimeMs` | 23.7 |
| `framesUnder16ms` | 96% |
| `framesUnder33ms` | 100% |
| capture frames | 97 (matches 11) |
| rebuild | 1.37× realtime (matches 11) |

**The render work is fast; the *scheduling* is starved.** Every painted
frame fits comfortably (96% under 16ms = 60fps budget) and the
renderer never produces a frame slower than 24ms. But only 81 frames
landed in 4 seconds — **rAF callbacks weren't firing often enough.**

The culprit is in this experiment's harness, not the architecture: the
4 atlas decoders were configured as **flat-out continuous loops** —
decoding the atlas as fast as `decodeQueueSize` allowed, with
`await wait(1)` polling for backpressure relief. That's a lot of
microtask churn competing with rAF callbacks for main-thread time.
Capture + worker rebuild compound it.

Production decoders won't run this way. They produce *exactly* one
frame per ~33ms tick, paced to playhead, not running flat-out. The
experiment will be redone with that pacing in
[17b](../17b_render-loop-paced/README.md).

## Note for eddy implementation

- **Pace atlas decoders to the playhead, not flat-out.** Each decoder
  should produce just enough to have the next-needed frame ready —
  ~30fps per decoder, not "as fast as it can." Flat-out decoding
  produces nothing visible (you can only show one frame per render
  tick anyway) but starves the rAF callback by saturating the event
  loop. 17 measured this directly: render work fits 60fps but actual
  delivered fps was 20.
- **Avoid `await wait(1)` polling** for backpressure. Use
  `decoder.ondequeue` events or a fixed interval. Tight polling is
  the worst of both worlds.
- **`gl.finish()` is for measurement, not production.** It serializes
  the GPU pipeline; the production renderer should issue draws and
  let the next frame's `texImage2D` overlap with the prior frame's
  presentation. The experiment uses it deliberately to attribute
  cost honestly.

## Caveats

- N=16, K=4 fixed (matches 11's worst realistic case). A K=8 layout
  (deeper splits) might be heavier — worth a follow-up if we ever
  see real-world layouts deeper than this.
- Single shader pass per cell. A real renderer may add per-cell
  effects (borders, transitions, masks); each adds work. This is
  the floor.
- Atlas decoders run in a tight feed-loop; the renderer pulls
  whatever's latest. In production the audio clock drives playhead
  position and the decoder is fed to match — slightly different
  pacing, similar total work.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
PORT=<port> experiments/harness/run.sh 17_render-loop
```
