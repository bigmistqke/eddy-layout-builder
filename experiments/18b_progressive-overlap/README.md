# progressive-overlap

**Question:** [18](../18_progressive-record/README.md) ran takes
serialized (record → wait for rebuild → next record), which made the
between-takes "gap" = rebuild time (7-13s). In production we wouldn't
wait — the new cell flips to bitmaps the moment recording stops, the
next take starts immediately, and atlas rebuild runs in the
background. What's the *real* user-visible gap, and what's hiding
inside 18's averaged fps numbers?

## Why

Three things 18 left on the table:

1. **The actual between-takes gap.** 18 serialized for simplicity but
   that's not the production shape. The gap = bitmap-flip latency =
   should be ~0ms.
2. **Per-frame jank.** Visible jank was reported on-device but 18's
   means (54-59fps) hid it. Frame-time outliers (p95, max, count
   over 33ms) are what the user perceives, not the mean.
3. **Recording integrity.** 18 counted chunks per take but not their
   timestamps. Are frames evenly spaced at 33ms intervals, or are
   there drops/gaps?

## Setup

Same 9 progressive stages as 18, with three changes:

1. **No wait for rebuild.** When recording stops, the new cell
   immediately flips to its bitmap series, and the next stage starts.
   Atlas rebuild gets queued in a background worker. Cells display
   atlas when available, bitmaps otherwise.
2. **Per-frame timing in the render loop.** Each tick records the
   wall-clock between consecutive paints. Sliced into per-stage
   windows so we can see jank per stage.
3. **Per-clip integrity check.** After each recording, walk the
   chunk timestamps from mediabunny's demux: compute expected vs
   actual frame count, max inter-frame gap, frames effectively
   dropped.

The rebuild queue uses a latest-wins policy: if a rebuild is in
flight and a new take lands, the new clip set is queued as pending;
when the in-flight rebuild finishes, its output is discarded if
superseded and the queue moves on.

## What's measured (per stage)

- `gapBeforeNextTakeMs` — wall-clock from stop[N] to start[N+1].
  Production target: under one frame budget (~33ms).
- `atlasReadyDelayMs` — wall-clock from stop[N] to atlas-with-N-cells
  available. Background metric: how long the user sees bitmaps.
- `recordRenderP95Ms`, `recordRenderMaxMs`, `recordFramesOver33ms`
  — jank distribution during the take.
- `recordedFramesExpected`, `recordedFramesActual`,
  `recordedFramesDropped`, `recordedMaxGapMs` — clip integrity.
- `bitmapKeepUpRatio`, `recordRenderFps`, `rebuildMs` — same as 18.

Plus session-level: total seconds, max queue depth observed,
sum of bitmaps in memory at peak.

## What this surfaces

- **Real flow latency**, not artificial serialization
- **Whether the rebuild queue actually stays bounded** under
  back-to-back takes (or balloons)
- **What 18's averaged fps was hiding** — outlier paints that the
  user sees as stutter
- **Whether the camera actually captures all 30fps** or quietly
  drops frames during recording

## Caveats

- Same harness limitations as 18 (6s takes, single sub-atlas per
  stage, no audio loop / playhead pacing).
- "Latest-wins" rebuild queue is one valid policy; alternatives
  (always-finish, parallel, partial cancel) would each have
  different behaviour. 18b picks this one for simplicity; production
  may want a different one.
- Inter-stage gap is measured in JS wall-clock time; doesn't include
  the user's reaction time / tap latency in a real session.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
TIMEOUT_MS=300000 PORT=<port> experiments/harness/run.sh 18b_progressive-overlap
```
