# sub-atlas-rebuild

**Question:** if we split the composite into K sub-atlases (each
covering N/K cells), changing one cell only re-encodes one sub-atlas —
~1/K of the full-atlas build cost. Does the build then fit inside the
recording window, and do K concurrent decoders still sustain realtime
playback?

## Why

[09_concurrent-build](../09_concurrent-build/README.md) found that a
full-atlas rebuild during recording slows from ~1.2× realtime (08) to
**~2.5× realtime** under capture+playback contention, while also dropping
26–54% of captured frames. The full-atlas "build hides inside the take"
hypothesis is falsified.

WebCodecs `VideoEncoder` can't update a sub-rect of a frame in an
existing bitstream — incremental at the codec level is impossible. But
splitting the composite into K independent sub-atlases recovers the
property: changing one cell only re-encodes the sub-atlas that contains
it. The trade-off shifts to K decoders at playback time:

- **Build cost** per change: ~1/K of full-atlas → if K=4, ~2.5 s for a
  6 s clip (= 0.4× realtime; finishes well inside the take).
- **Playback cost**: K concurrent decoders, each at `atlasH/√K`-ish
  resolution. 04 showed K=4 large streams sustain realtime; sub-atlas
  decoders are larger per-stream than the streaming experiment but
  fewer in total.

This experiment measures both halves under realistic load.

## Setup

Records once at `captureResolution`. For each K in `subAtlasCounts`
(1, 2, 4) at fixed N=16:

1. **Build all K sub-atlases.** Each sub-atlas tiles `N/K` cells from
   the source; together they cover the same total cell area as one
   N=16 atlas. Report per-sub-atlas build ms.
2. **Pure-playback pass.** K decoders concurrently loop their
   sub-atlases for `runSeconds`. Report per-decoder min / aggregate
   fps. (K=1 = 09's atlas-decode baseline.)
3. **Contended-rebuild pass.** Camera capture + playback of all K
   sub-atlases + a Worker rebuilding **one** sub-atlas (the
   "user just changed cell c"). Report capture frames, per-decoder fps,
   and the one-sub-atlas build ms / rate / `finishedInWindow`.

## What to look for

The flow works if **all three hold simultaneously** in the contended
pass at some K ≥ 2:

- **Capture frames** ≈ baseline (no encode starvation during recording)
- **Per-decoder playback fps** ≥ 30 (loop stays smooth)
- **One-sub-atlas build rate** ≤ 1.0× realtime (rebuild finishes
  inside the take it was triggered by)

K=4 is the natural sweet spot — small enough that 4 concurrent
decoders should be safe (04: 4 streams ✅), large enough that 1/4 build
cost (~0.6× realtime, even contended) fits inside any take.

If even K=4 doesn't satisfy all three, the next move is K higher
(K=8 = 1 cell per sub-atlas = pure streaming — already known to wall),
or deferring the rebuild to after the take stops.

## Caveats

- Sub-atlas tiling here uses the same source clip in every cell (same
  as 05/07/09) — identical content compresses optimistically. The
  build-cost number is therefore a lower bound; real distinct-content
  builds will be heavier per-pixel.
- The rebuild only re-encodes one sub-atlas, but assumes the input
  cells (encoded clips) are already on disk. The OPFS read cost is
  bundled into `compositeMs` indirectly via the source clip already in
  memory.
- Single Worker rebuild. If a session has multiple rapid changes,
  rebuilds queue — out of scope here.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
PORT=<port> experiments/harness/run.sh 10_sub-atlas-rebuild
```
