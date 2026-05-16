# concurrent-build

**Question:** during a recording session, can the device run the atlas
**build** of the existing takes concurrently with **camera capture +
encode** of the new take *and* **playback of those existing takes** —
without any of the three degrading?

## Why

[08_build-cost](../08_build-cost/README.md) put the atlas build at ~1.2×
realtime — so a 5-min song's composite takes ~6 min to bake, which
*looks* like it breaks the "stop recording → take is already in the
loop" UX promise.

But the user is committed to the device for the whole recording window
anyway: a take is at least song-length, and during it they're already
paying for camera capture + playback of the existing takes. If the
composite build can run *in that window* — using the existing takes
already on disk as input — then by the time recording stops, the atlas
of the prior take-set is ready and only the new take needs to be folded
in. The "baking beat" disappears.

This is the contention test that decides it.

## Setup

For each N in `gridSizes`:

1. **Pre-pass.** Record a `recordSeconds` source clip and pre-build an
   atlas of N copies of it (`harness/composite.ts`). That atlas
   represents the "existing baked state" the user is playing back while
   they record.
2. **Baseline pass.** For `runSeconds`, run two workloads concurrently
   on the main thread:
   - Camera capture via MediaRecorder (the "new take being recorded").
   - Decode loop on the baked atlas (the "loop playback").
   Measure captured-frame count (post-stop demux) and playback fps.
3. **Contended pass.** Same as baseline, **plus** a Worker running
   `harness/composite.ts` on the source clip (the "background atlas
   rebuild of the existing N+1 takes"). Measure the same two metrics
   under contention, and record the build's wall-clock + whether it
   finished within `runSeconds`.

Sweep N ∈ `{9, 16}` — covers the grid sizes where the atlas is required
(N≤4 streams natively per 04, no atlas needed). Build runs in a Worker
because 07 confirmed it's worker-safe; the comparison is therefore
**workers contending with the main thread**, the actual production
shape.

## What to look for

Each of the three workloads must hold *independently* under contention:

- **Captured clip integrity** — `contended.captureFrames` ≈
  `baseline.captureFrames`. A drop means the encoder is starving and the
  take itself is being corrupted.
- **Playback fps** — `contended.playbackFps` ≥ ~30. A drop means the
  user sees stutter on the loop while recording.
- **Build rate** — `contended.buildRateVsRealtime` ≤ ~1.0. If the build
  takes longer under contention than the recording window itself, the
  pre-bake hasn't finished by stop-recording and the UX promise breaks.

If all three hold: the recording flow can feel free — stop recording,
fold the just-finished take into a ready-baked atlas, back to the loop.
If any fails: we need either a sub-atlas incremental update, a
brief post-record bake, or to throttle the build during capture.

## Caveats

- v1 sweeps only `{9, 16}`; N=25 likely fits the same shape but adds
  OOM risk given 08's 16s ceiling — defer until needed.
- Single Worker build, not chunked. 08 showed single-pass composites
  OOM past ~9s, so `recordSeconds` is capped well under that.
- Captured-frame count is a coarse integrity proxy (no per-frame jitter
  analysis). Sufficient to flag starvation; not sufficient to claim
  perfect capture.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
PORT=<port> experiments/harness/run.sh 09_concurrent-build
```
