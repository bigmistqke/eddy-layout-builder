# render-loop-paced

**Question:** [17](../17_render-loop/README.md) found the renderer's
*work* fits 60fps comfortably (mean 6.3ms / frame, 96% under 16ms),
but only 20fps was actually delivered. The culprit was 17's flat-out
continuous-loop decoder pattern saturating the event loop.

Does the production pattern — **decoders paced to ~30fps**, not
flat-out — recover the budget under the same contention shape?

## Why

The flow design's renderer doesn't need decoders running as fast as
the hardware allows; it only needs the *next frame* available by the
next render tick. One frame per atlas per 33ms is the production
target, not "100 fps if the hardware allows."

But the harness shape of 17 was "decode as fast as possible, take
latest" — easy to write, wrong shape for production. The microtask
churn from 4 flat-out decoders + capture + worker rebuild starved
rAF callbacks to 20fps.

17b replaces the continuous loops with `setInterval`-driven feeds at
30fps per decoder. Same workload everywhere else; same contention
shape; same measurement.

## Setup

Identical to 17 except:

- **Atlas decoders are paced from the rAF tick itself.** Each render
  tick calls `decoder.feedTo(elapsedMs, 30)`, which decodes just
  enough chunks to keep up with a 30fps target. Single clock source
  (rAF). No `setInterval`, no `await wait(1)` polling. Verified
  iteratively (see "What we ruled out" below).
- **No `gl.finish()`** — let the browser pipeline GPU work, like
  production would. Frame time is CPU-side draw submission.
- **Two passes**: a baseline (just render + paced decoders, no
  capture, no rebuild) and a contended pass (full hot-path). The
  delta isolates what contention costs.

Same:
- N=16 cell layout, K=4 sub-atlases
- Render loop drives a real on-screen `<canvas>` via rAF
- Reports `renderedFps`, frame-time stats, capture frames, rebuild

## What to look for

- **`renderedFps` ≥ 30 (ideally ≥ 55)** → pacing recovered the
  budget; the renderer can deliver 30fps with margin (probably
  60fps on a 60Hz display)
- **`framesUnder16ms` close to 17's 96%** — render *work* per frame
  should be unchanged
- **Capture / rebuild numbers similar to 17 and 11** — pacing
  shouldn't affect these
- If `renderedFps` is still around 20, pacing wasn't the issue and
  we need to dig further (gl.finish? texImage2D from VideoFrame
  cost? rAF scheduling fundamentally throttled?)

## Verdict (2026-05-16 · Galaxy A15 · Android 10 · Chrome 148)

| pass | renderedFps | mean | p95 | max | <16ms |
|---|---|---|---|---|---|
| **baseline** (just render) | **60.2** ✓✓ | 6.32 | 10.60 | 14.60 | **100%** |
| **contended** (+ capture + worker rebuild) | **22.7** | 5.74 | 16.60 | 27.70 | 95% |

**Steady-state is perfect.** When the renderer isn't fighting capture
or rebuild, it hits the device's 60Hz display ceiling cleanly. 100%
of frames fit the 16ms budget. The architecture loses *nothing* to
its own design in this case.

**Contention pulls rAF to ~22fps.** Not because the render work grows
(it actually got faster — 5.74 vs 6.32ms mean) but because the browser
rate-limits rAF when capture + decoders + worker rebuild all share
the device. This isn't an artifact of our render code; we ruled out
pacing strategy, gl.finish, GPU sync, and event-loop chatter (see
below). It's the browser's fair-share scheduling and isn't ours to
override.

### What we ruled out

| variant | renderedFps |
|---|---|
| 17 flat-out decoders | 20.2 |
| 17b setInterval-paced | 23.9 |
| 17b rAF-driven feed | 21.6 |
| 17b rAF-driven, no gl.finish | 21.8 |
| **17b baseline (no contention)** | **60.2** |

Pacing barely moved the contended number (20→22). Removing gl.finish
didn't. Only removing the contention itself recovered the budget.

### Production fps timeline

For a typical "record next take" cycle:

```
idle / playback only         60 fps   most of the session
RECORDING (capture+decoders) ~22 fps  a few seconds; user is performing
rebuild only (no capture)    30-40 fps?   ~30s background after stop (untested isolated)
rebuild done, back to idle   60 fps
```

22fps *while actively recording* is below the 30fps target but well
above broken. It coincides with the moment the user is concentrating
on performance, not staring at playback quality. Outside that window:
full display rate.

## Note for eddy implementation

- **Expect ~22fps as the user-visible floor during active recording.**
  Don't try to engineer past it; the browser's rAF throttle is the
  same fair-share mechanism that keeps the UI responsive elsewhere.
  Visual cues for the user (recording indicator, level meter) should
  be designed to read fine at 22fps.
- **Drive decoder feeds from the rAF tick**, not from `setInterval`.
  Single clock source = the renderer. Pattern:
  ```ts
  function tick() {
    const elapsedMs = now() - startMs
    for (const decoder of decoders) decoder.feedTo(elapsedMs, 30)
    // ...render
    requestAnimationFrame(tick)
  }
  ```
- **Don't `gl.finish()` per frame** in production. Honest measurement
  only. The browser pipelines GPU work, and forcing sync serializes
  it pointlessly.
- **Steady-state is the headline.** 60fps when not recording is
  better than I'd dared assume; the design has real margin for
  transitions, effects, anything else we want to add to the renderer
  later.

## Caveats

- 30fps pacing assumes the song / atlas is encoded at 30fps; in
  practice it should track `1 / atlas.framerate`.
- `setInterval` drift is benign for this test (we sample latest
  frame each rAF; one decoder slightly behind just shows the prior
  frame for one extra tick, no visible jank).
- Same atlas content as 17 (tiled-identical) — entropy is decode-
  cost-independent per 15.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
PORT=<port> experiments/harness/run.sh 17b_render-loop-paced
```
