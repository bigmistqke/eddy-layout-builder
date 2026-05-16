# progressive-streams

**Question:** does the simplest possible architecture — **one decoder
per cell, no atlas, no bitmap series, no worker rebuild** — sustain
realtime through the 9-stage progressive recording? 04 said K=4
streams hold; K=5-9 is untested under capture contention.

## Why

[18c](../18c_opfs-bitmaps/README.md) fixed the memory ceiling but
left the jank: rebuild-during-record contended with capture (the
17b finding). Container-aligned atlases (11) don't naturally help
*here* because the 9 strips ARE all siblings in one vertical
container → one leaf-container of 9 cells → mono-atlas again.

The contrived "each cell = its own leaf container" structure has a
simpler equivalent: skip the atlas entirely, stream each cell's
clip directly. No rebuild = no contention. Per 04, K=4 streams hold
realtime; we just don't know what K=5-9 looks like, especially
during concurrent recording.

If pure streaming holds at K=9 (or whatever K it walls at), the
progressive scenario doesn't need atlases at all — and we know the
upper bound for "how many cells before atlas grouping becomes
mandatory."

## Setup

Same 9-stage progressive as 18c. Per stage:

1. Add new cell (live camera).
2. Start `MediaRecorder` for `takeSeconds`. No bitmap pipeline,
   no worker rebuild.
3. On stop: demux clip, spin up a fresh `VideoDecoder` for this
   cell, advance to next stage. Decoder feeds chunks from rAF
   tick (per 17b — single clock source, no `setInterval`).

Per render tick: for each cell with an active decoder, feed up to
the target frame index for elapsed time; paint each cell from its
decoder's latest `VideoFrame` (or the preview `<video>` for the
live cell).

## What's measured

Per stage:
- `recordRenderFps` — render fps during recording (= the user's
  on-screen smoothness during a take)
- `recordRenderP95Ms` / `recordRenderMaxMs` / `recordFramesOver33ms`
  — jank profile
- `integrity` — per-clip frame count + drops + meanInterval
- `gapBeforeThisTakeMs` — should be near zero

Session:
- `peakHeapMb` — should stay tiny (no bitmaps, no in-memory atlas)
- `sessionSeconds` — total wall-clock

## What to look for

- **`recordRenderFps` ≥ 30 across all stages** → pure streaming
  works for the whole 9-stage span; no atlas needed for this
  layout
- **`recordRenderFps` drops at some K** → identifies the streaming
  ceiling under capture contention; cells beyond K need atlas
  grouping
- **`integrity.framesDropped` low** → capture isn't starving from
  decoder contention
- **`peakHeapMb` tiny** → memory is bounded as expected (encoded
  clips are small)

If this works, **the entire 18b/c architecture (bitmaps, OPFS,
atlas rebuild) becomes unnecessary in this scenario** — it's
needed only when N exceeds the streaming budget AND the layout
forces cells into the same leaf container.

## Verdict (2026-05-16 · Galaxy A15 · Android 10 · Chrome 148)

**Pure streaming walls at K≈4.** Smooth through K=3, starts hitching
at K=4, meaningfully janky from K=5 upward — even though mean fps
stays above 30.

| stage | recordFps | p95 | max | over33 frames | over33 % | perceived |
|---|---|---|---|---|---|---|
| 1 | 60.2 | 19.5 | 35.9 | 1 | 0.6% | smooth |
| 2 | 59.9 | 19.5 | 23.9 | 0 | 0% | smooth |
| 3 | 59.9 | 20.3 | 32.4 | 0 | 0% | smooth |
| 4 | 50.4 | 34.3 | 44.9 | 24 | **13%** | noticeable hitches |
| 5 | 43.6 | 36.1 | 63.8 | 45 | **25%** | janky |
| 6 | 40.1 | 38.0 | 57.5 | 55 | **31%** | janky |
| 7 | 40.9 | 38.7 | 54.8 | 56 | **31%** | janky |
| 8 | 35.0 | 46.9 | 70.0 | 79 | **44%** | very janky |
| 9 | 34.4 | 46.2 | 66.5 | 83 | **46%** | very janky |

Camera capture stays clean throughout (0-5 frame drops per take,
29.2-29.9 fps measured). Memory peak: 10 MB.

**Compared to 18c at the same K:** max frame time 70ms vs 1032ms,
camera drops 0-5 vs 7-25. The rebuild contention is *gone* — but a
different ceiling appears: hardware decode bandwidth (per 04 / 06)
splits across K streams, and beyond K≈4 each decoder gets too
little.

### Why mean fps misled

Reading "stage 9: 34.4 fps" looks like "above 30, fine." But 46% of
frames take >33ms — every other frame is a stutter beat. The eye
sees stutter, not the mean. **`framesOver33ms` count is the honest
perceived-smoothness metric**, not `recordRenderFps`.

This also reframes 17b: its "contended 22 fps" with `framesUnder33ms`
= 95% was actually mostly-smooth despite the low fps — the rAF
throttle slowed *the rate* without making individual frames slow.
Different failure mode than 18d's K=9.

## Note for eddy implementation

- **Pure streaming is the right path for K ≤ 4.** No atlas, no
  bitmaps, no worker rebuild — simplest possible architecture for
  the common case. 60 fps smooth, no camera drops, ~10 MB memory.
- **K > 4 requires atlas grouping.** Per 11's K=4 sub-atlas
  verdict, atlas decode at K=4 holds ~30 fps under contention.
  The architecture really needs **K leaf-container atlases where
  each container holds ≤ 4 cells**. The challenge from 18c (jank
  during recording) is the rebuild-during-record contention, which
  the deferred-rebuild / smaller-rebuilds approach is supposed to
  fix.
- **Watch `over33ms` not mean fps for smoothness.** Mean rates lie
  about perceived smoothness when the distribution is bimodal
  (some frames fast, others very slow). Production telemetry
  should track this.
- **Camera capture is robust** to decode contention — it's the
  *render path* that suffers, not the recording. So even janky
  playback during recording doesn't damage the captured take.
  Useful for prioritising what to fix.

## Caveats

- **No persistence.** All decoders consume in-memory clip chunks.
  A real implementation might re-decode from OPFS on demand;
  experiment skips that for simplicity.
- **Looping.** Each decoder feeds chunks once through; once
  exhausted, the cell freezes on its last frame. The experiment
  ends before any cell wraps. Looping mechanics (flush + reset +
  reconfigure on wrap) are deferred — they're a separate concern
  and would only affect playback beyond song length.
- **Audio.** Not modelled here; this is the visual side only.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
TIMEOUT_MS=300000 PORT=<port> experiments/harness/run.sh 18d_progressive-streams
```
