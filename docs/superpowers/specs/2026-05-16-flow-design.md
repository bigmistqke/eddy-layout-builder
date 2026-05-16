# eddy flow design

**Date:** 2026-05-16
**Status:** approved design, not yet implemented
**Builds on:**
- `docs/superpowers/specs/2026-05-11-eddy-mvp-design.md` (concept, composition, transport)
- `docs/superpowers/specs/2026-05-14-video-playback-scaling-design.md` (composite vs streaming)
- Experiments 04-14 (composite, streaming, sub-atlas rebuild, bitmap series, cold-start, atlas swap)

## What this spec covers

The shape of a recording session as the user experiences it: opening
the app, starting the first take, committing one take after another,
re-recording, listening to the loop. Defines the cell state machine,
the rendering contract, the loop-boundary synchronisation point, and
the two background builders that keep the loop smooth.

What it does NOT cover: the WebGL renderer's draw code, the OPFS
on-disk layout in detail, layout-edit interaction with rebuild
priority, export (deferred to v2 per the MVP spec).

## Core decision: the app is the loop

The loop is the app's resting state. Once anything plays-able exists
— even just the empty grid with the camera live — the loop is
running. Recording is a state a *cell* enters, never a mode the
*app* enters.

There are only two transport states:

- `stopped` — no playback, clips retained, atlases retained.
- `looping` — the loop is running, cells render according to their
  per-cell state.

The user goes `stopped → looping` by starting the first take or
hitting Play; `looping → stopped` only via an explicit Stop
affordance. Everything else happens *inside* `looping`.

## Cell state machine

Each cell is in exactly one of six states at any time:

```
empty              black, selectable
live-preview       camera in this cell (selected-empty)
armed              live-preview + visual pulse on loop position
recording          live-preview + MediaRecorder writing the new clip
playing-bitmaps    bitmap series @ 30fps, no decoder used
playing-atlas      sub-atlas decoder paints this cell at its tile rect
```

The intermediate `pending-bitmaps` state from the brainstorm is gone:
bitmaps are generated *during* recording (12b), so the series is
complete the moment recording stops. There is no gap.

Cell transitions:

```
empty → armed (via tap on the cell)
empty → live-preview (via selection)
live-preview → armed (via tap record / arm)
armed → recording (at next loop boundary 0)
recording → playing-bitmaps (at next loop boundary 0 after auto-stop)
playing-bitmaps → playing-atlas (at next loop boundary 0 after sub-atlas rebuild lands)
playing-atlas → armed (re-record: drops clip on arm, atlas becomes
                       stale; cell goes silent + live-preview)
any → empty (via delete)
```

**All state changes happen at loop boundary 0** — never mid-loop.
This is the one sync point in the system. Renderer transitions are
visually atomic; audio re-schedules at the same instant.

## Per-frame rendering

Each frame, the renderer asks every cell one question: "what should I
paint right now?" The answer is determined by cell state:

| state | source |
|---|---|
| `empty` | black |
| `live-preview` / `armed` / `recording` | the persistent preview `<video>` element |
| `playing-bitmaps` | `bitmaps[ floor((position - cellStartOffset) * 30) ]` |
| `playing-atlas` | the sub-atlas `VideoDecoder`'s current frame, sampled at the cell's sub-rect |

One `texImage2D` per cell per frame, drawn at the cell's frame rect
(from existing `layoutFrames`). At K=8 cells this is ~5ms per frame
total (12 baseline measurement).

## Loop boundary as the only synchronisation point

`Transport` emits `onLoopBoundary` at each cycle start. A queue of
pending cell-state transitions is drained at every boundary:

- `armed → recording`: MediaRecorder starts, AudioBufferSourceNode
  for the previous clip (if any) is dropped, bitmap pipeline (12b)
  starts capturing
- `recording → playing-bitmaps`: bitmap series is already complete
  (12b); new audio clip is scheduled into the loop on this boundary
- `playing-bitmaps → playing-atlas`: sub-atlas decoder takes over,
  bitmap memory freed; the held first VideoFrame (14) is rendered
  this frame, decoder continues for subsequent frames

The contract: the user stops recording → on the very next loop pass,
they hear the take AND see it (low-res via bitmaps). The atlas swap
settles silently over the next minute. Sample-accurate audio sync;
visually atomic video transitions.

## Two background builders

When a cell changes (new take, re-record, layout edit affecting its
container), two Workers fire in parallel, both decoding the same raw
source clips from OPFS:

### Builder A — bitmap-series

Runs **during** recording via `MediaStreamTrackProcessor` + Worker
(12b). Reads `VideoFrame`s from the camera, downscales to a small
canvas (~96×174), emits `ImageBitmap` per frame, transferred back to
main thread. 100% keep-up at 30fps, mean latency 3.6ms. Series is
complete at recording-stop with no post-processing.

For non-recording dirty-state cases (layout edits, cold-start into a
dirty atlas), runs **after** the fact — decodes the clip from OPFS,
emits bitmaps. ~0.34× realtime cost (12), so a 30s clip → ~10s
build. The cell shows the last known frame (or a static placeholder)
during this gap.

### Builder B — sub-atlas (container-aligned)

Per-leaf-container in the layout tree (11), not a fixed K. When any
cell in container `c` changes, container `c`'s sub-atlas is
re-encoded from the raw clips of all cells in `c`. Always rebuilt
from raw — no generation loss accumulates.

Cost: ~1.18× realtime under contention with capture + atlas decode +
bitmap paint (10/11 at CSS-pixel resolution, 540×983 atlas). For a
30s song, a single sub-atlas rebuild is ~36s wall-clock. Fits inside
the recording window of the next take with margin.

Both Workers process FIFO, one job at a time per builder. If the
user records 4 takes back-to-back, the queue serializes them; the
cells all visibly succeed via bitmaps, only the final atlas swaps lag.

### No generation accumulation

Every sub-atlas cell is always at exactly **1 VP8 generation** from
raw camera output. Every bitmap is **1 generation** (decoded then
rasterised; the raster is final). Compositing happens at WebGL draw
time, never at the encoder. Recording 100 takes never compounds.

## Atlas persistence + cold start

Sub-atlases are persisted to OPFS as encoded `.webm`-equivalent blobs.
Manifest carries a per-container `sourceHash` (hash of the set of
cell-clips that produced the atlas). On any state change affecting a
container, recompute the hash; mismatch = atlas dirty.

Cold-start path:

```
boot → read layout from OPFS
     → read atlas manifest
     → for each leaf container:
         fresh? → start atlas decoder → cell in playing-atlas
         dirty? → enqueue Builder A + Builder B → cell starts in
                  live-preview frame (or last-known) → playing-bitmaps
                  → playing-atlas
     → enter looping
```

Measured cold-start latency for clean atlases (13): single 219ms,
K=4 parallel 561ms. App opens into the loop in well under 1s.

Bitmaps are session-only — cheap enough to regenerate on demand, not
worth the OPFS write-and-keep-fresh cost on every take.

## Atlas swap pattern

When Builder B completes a sub-atlas rebuild, the cells in that
container don't swap immediately — that would interrupt the current
loop pass. Instead:

1. The new atlas is persisted to OPFS.
2. A new `VideoDecoder` is created, configured, fed its first chunk.
   The resulting `VideoFrame` is **held** in memory.
3. The cell sits in a "pre-warmed" sub-state, still painting from
   bitmaps or the old atlas.
4. At the next loop boundary, the cell's source pointer flips. The
   held `VideoFrame` paints this frame; the new decoder feeds
   subsequent frames.

Validated by 14: hot swap is 0ms (pointer flip); cold swap (configure
+ decode at swap moment) is 270ms = ~8 visible blank frames. The
pre-warm pattern is mandatory.

`VideoFrame`s held across short waits (~500ms tested) remain valid.
Longer holds untested; not expected to be a problem at this scale.

## Where the architecture sits in the design space

| dimension | choice | why |
|---|---|---|
| Playback representation | sub-atlas (container-aligned) | O(1) per-container decode, layout-aware cache boundary (11) |
| Granularity | one per leaf container | matches user editing scope; K dynamic per layout |
| When rebuilt | between-takes, in workers | build-during-record falsified (09); between-takes fits via parallel workers |
| Rebuilt from what | raw OPFS clips | no generation loss (per `video-playback-scaling.md` requirement) |
| Atlas resolution | CSS-pixel (~540×983) | sweet spot per 10's sweep: sharp at standard density, contention-free |
| Gap during rebuild | bitmap series | sidesteps decoder budget (12), generated during record (12b) so no gap |
| Cold start | persisted atlas + sourceHash | under 1s open into loop (13) |
| Atlas handoff | pre-warmed decoder + held VideoFrame | 0ms swap (14) |

## Validation summary

| Claim | Backed by |
|---|---|
| Composite is O(1) in N, beats streaming past N=4 | 04, 05 |
| Hardware decode-bound; workers don't add throughput | 06 |
| Composite pipeline is worker-safe | 07 |
| Atlas build ~1.2× realtime, linear; chunking mandatory for memory | 08 |
| Build-during-recording fails: 1.2× → 2.5× under contention; capture drops | 09 |
| K=4 sub-atlases at CSS-pixel res is the sweet spot | 10 |
| Container-aligned sub-atlases hold to K=8, get *better* with K | 11 |
| Bitmap-series gap-filler works (K≤4 safe) | 12 |
| Bitmaps can be generated during recording at 100% keep-up | 12b |
| Cold-start from OPFS is under 1s (single 219ms, K=4 561ms) | 13 |
| Atlas swap at loop boundary is 0ms with pre-warmed decoder | 14 |

## Not yet validated / explicitly deferred

- **Distinct-content overhead.** All experiments tile the source clip
  identically across cells. Real cells have distinct content (higher
  entropy → larger atlases, slightly heavier decode). Worth a single
  sanity run before src/ work but not expected to flip any decision.
- **Audio integration with the rebuild queue.** Audio is already
  scheduled via existing `transport.ts`; the boundary contract is
  defined. Implementation will surface any gotchas.
- **Long-held VideoFrame lifetime.** 14 tested 500ms hold. Production
  may hold a few seconds. Should be fine; add a regression test.
- **Layout edits with rebuild already in flight.** A user splits cell
  X while a different sub-atlas is rebuilding. The new split
  invalidates a different (potentially overlapping) sub-atlas. Queue
  policy: enqueue the new dirty container, let current rebuild
  finish. Edge case; needs a small "cancel-and-replace" mechanism if
  the same container is dirtied twice quickly.
- **Single-cell containers as streams.** Per 04, a 1-cell container
  could stream the clip directly instead of paying the atlas-build
  cost. Worth a code path in production but not strictly necessary —
  bitmap-series + sub-atlas works for 1 cell too.

## Next step

Hand off to writing-plans to break this into implementation tickets.
The natural decomposition follows the module boundaries already
discussed:

1. `src/playback/cell-source.ts` — the state machine + per-frame
   resolver (the single source of truth for "what does this cell
   paint")
2. `transport.ts` extension — `onLoopBoundary` event + pending clips
3. `src/builders/bitmap-builder.ts` (Worker, MediaStreamTrackProcessor
   path) + `src/builders/atlas-builder.ts` (Worker, productionised
   `harness/composite.ts`)
4. `src/playback/atlas-decoder.ts` — wraps one `VideoDecoder` per
   leaf container; pre-warm + handoff logic from 14
5. `src/state/projects.ts` extension — atlas manifest + sourceHash
6. `src/components/canvas.tsx` extension — call `cell-source.frameFor`
   per cell per frame
7. Retire `src/media/video-decoder.ts`'s pre-decoded-ImageBitmap path
