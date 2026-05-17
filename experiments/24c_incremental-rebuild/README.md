# incremental-rebuild

**Question:** [24b](../24b_render-loop-hybrid/README.md) showed the
hybrid (M atlas + D dirty streams) breaks down at D ≥ 4-8. The whole
eventually-consistent atlas pattern depends on rebuilds draining
dirty slots fast enough to keep D bounded. **Does incremental
rebuild — one atlas at a time, queued on each edit — actually keep D
small under realistic edit rates? And what's the edit rate above which
the system can't keep up?**

## Why

[24a](../24a_render-loop-av1-atlas/README.md) measured atlas build at
1.1-2.8 s wall-time uncontended. [09](../09_concurrent-build/README.md)
showed atlas builds slow 1.2× → 2.4× under playback contention (VP8
era; AV1 may differ). So per-rebuild wall time during playback could
be 1.5-5 s.

The hybrid architecture's viability hinges on: **edit rate × rebuild
time < 1** (rebuilds keep up). If that ratio exceeds 1, the dirty
queue grows unbounded, D climbs past the 24b ceiling, and playback
janks.

This experiment simulates an edit stream + an incremental-rebuild
scheduler running concurrent with the K=16 / M=4 render loop, and
measures whether D stays bounded.

## Setup

Same baseline as 24b: K=16 cells, M=4 atlases (2×2 cells each at
270p mip), one per-cell AV1 mip prepared up front. Render loop drives
M atlas decoders + per-cell decoders for currently-dirty cells.

Add two background schedulers:

1. **Edit scheduler** — at edit rate R, pick a random clean cell,
   mark it dirty (spawn a per-cell paced decoder for it; update cell
   spec to source from per-cell). Enqueue its atlas for rebuild if
   not already queued.

2. **Rebuild scheduler** — serial: while queue non-empty, dequeue an
   atlas index, build a fresh atlas async (decode source → tile → AV1
   encode), then swap the atlas decoder and mark all that atlas's
   cells clean (tear down their per-cell decoders).

Sweep edit rates R ∈ {0.25, 0.5, 1.0, 2.0} edits/s. Run each for 20 s.

## What's measured

Per pass:
- Render fps + standard JankRecorder stats (mean / p95 / max / over33msRatio / streak / score)
- Long-tasks observed
- Aggregate decode fps (atlas + per-cell)
- **D over time** — sampled per tick; max, mean, p95
- **Rebuilds completed** during the run
- **Mean rebuild wall time** (under contention with playback)
- **Edits applied** vs edits attempted (if dirty queue fills past K, edits skipped)

## What to look for

- **R=0.25 stays at D ≤ 1, no jank** → low edit rate easy
- **R=0.5 / 1.0 stays bounded around D=1-2, render clean** →
  incremental rebuild keeps up; the architecture works for normal
  use
- **R=1.0 / 2.0 D climbs over time, jank correlates** → rebuild
  can't keep up; reveals the practical edit-rate ceiling
- **Rebuild contended-time ≈ uncontended** → render loop doesn't
  starve the rebuild (good); else need to shift rebuild to worker
- **Jank spikes when each rebuild completes** → the atlas-swap
  operation itself is a hitch; needs the 14/16 hold-pattern
  treatment for AV1

## Caveats

- "Edits" here mean *one cell becomes dirty*. Real eddy edits may
  affect 1 cell (replace one clip), multiple cells (drag, layout
  change), or zero cells (parameter tweak).
- Rebuild runs async on the main thread (decode + draw + encode), not
  in a worker. Worker-based rebuild is the natural follow-up; this
  experiment is the inline baseline.
- The atlas that gets rebuilt isn't actually picking up *new*
  content (same source for everything), so we measure the rebuild
  *cost* and *coordination*, not new-content semantics.
- Atlas-swap is naive: drop the old decoder, configure the new one,
  resume rendering. 14/16's pre-warm + frame-hold patterns aren't
  applied here. Swap hitches are a finding, not a fixed parameter.
- 20 s per pass — short enough to be quick, long enough for ~4-40
  edits per pass depending on rate.
- Edit scheduler picks cells uniformly at random; realistic edit
  patterns may cluster (e.g., user edits same cell repeatedly).
- Same source clip for every cell + every atlas slot. Per 15
  cross-cell entropy isn't load-bearing for atlas decoding.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
TIMEOUT_MS=600000 PORT=<port> experiments/harness/run.sh 24c_incremental-rebuild
```
