# progressive-overlap-chunked

**Question:** the full production hot-path: capture a new take while
(a) the **previously-recorded cells render from OPFS lo-fi bitmaps**
and (b) the **atlas for the prior cells builds in the background as
chunks**. Does the chunked pattern from 18e/18f hold up here, where
18c's mono build catastrophically janked?

## Why

The flow design assumes we can overlap: start recording the next take
immediately when the previous one stops, no wait, atlas rebuilds in
the background. [18c](../18c_opfs-bitmaps/README.md) validated the
*shape* (gap ~0 ms, OPFS keeps memory bounded) but the mono atlas
build contended heavily with capture + render — jankScore 27 000
at worst.

[18e](../18e_idle-build/README.md) showed chunked builds with yields
hold render at baseline jank in a single-pass spike.
[18f](../18f_progressive-chunked/README.md) showed that holds across
a 9-stage *serialized* progressive flow (no overlap with recording).

18g is the missing combination: **9-stage progressive + overlap +
chunked builds**. If smooth, the architecture is fully validated for
production.

## Setup

Same 9 progressive stages as 18c/18d/18f.

Per stage:
1. Add new cell (live camera) at the bottom of the layout.
2. **Start recording** (MediaRecorder + `MediaStreamTrackProcessor`
   bitmap-writer worker writing raw RGBA per frame to OPFS).
3. **Immediately**, concurrent with recording, kick off a **chunked
   atlas build** (3 sequential chunks via 18e's chunk-worker, with
   `setTimeout(0)` yields between) for all clips so far.
4. **Cells 0..N-1 render from OPFS lo-fi bitmaps** via the reader
   worker (per 18c). The new cell renders live preview `<video>`.
5. On recording stop:
   - New cell flips to OPFS-streaming source.
   - Advance to next stage immediately (no wait for atlas).

Atlas builds queued FIFO with latest-wins (per 18c): if a build is in
flight when a new stage stops, the in-flight build's output is
discarded if superseded.

This experiment does NOT decode atlases back into cells — cells
always render from OPFS in v1. Atlas is built for the validation
that "chunked builds during overlap" don't contend; the swap-to-
atlas path is covered separately (16, and partially in 18c).

## What's measured

Per stage:
- `recordJank` — full JankReport during the recording window (the
  key metric: chunked-during-record vs 18c's mono-during-record)
- `recordRenderFps` — convenient summary
- `integrity` — recorded clip frame count + drops
- `gapBeforeThisTakeMs` — production-shape gap (should be ~0)
- `buildEvents` — per-chunk wall-clock + when each chunk completed
- `bitmapKeepUpRatio` (writer) — OPFS write keep-up under contention
- `atlasReadyDelayMs` — wall-clock from stop[N] to atlas[N] ready
  (background latency)

Session:
- `peakHeapMb` — should stay tiny (OPFS-backed bitmaps)
- `sessionSeconds` — total
- `longtasks` — PerformanceObserver entries

## What to look for

- **`recordJank.jankScore` ≪ 18c's** at every stage → chunked builds
  do not contend with recording (the headline claim)
- **`recordJank.jankScore` ≈ 18d's pure-streaming** at K ≤ 4 →
  matching the smoothest possible architecture
- **Capture drops low** (0-5/take, per 18d) → encoder pipeline not
  starving
- **`peakHeapMb` ≤ 20 MB** → OPFS keeps the in-memory cost bounded
- **`gapBeforeThisTakeMs` ≈ 0** → overlap works

## What could fail

- Concurrent OPFS write (bitmap-writer for new cell) + OPFS read (for
  previous cells) + atlas-build worker pre-decoding sources + capture
  + render — many workers contending. Even chunked builds might lose
  to that total contention.
- The atlas build worker pre-decodes all source clips per stage; at
  stage 9 that's 9 source decodes + chunked composite. Substantial
  per-stage cost.

## Verdict (2026-05-16 · Galaxy A15 · Android 10 · Chrome 148)

**The full production hot-path works smoothly — but the first
implementation required fixing a hidden contention source.**

### First attempt: catastrophic

Original 18g spawned a fresh `ChunkWorker` per stage, with its
`prepare()` pre-decoding ALL source clips. At stage 4 that's
~720 decodes in one tight loop, concurrent with capture:

| stage | jankScore | max | streak | cam drops | recFps |
|---|---|---|---|---|---|
| 1 | 7 | 83 ms | 1 | 8 | 58 |
| 2 | 2068 | 414 ms | 3 | 26 | 33 |
| 3 | 1610 | 280 ms | 3 | 19 | 34 |
| 4 | **31952** | **550 ms** | **8** | 19 | **8.6** |

Plus a queue-race bug ("`startBuild: in-flight already exists`")
where the latest-wins recursion fired before clearing the in-
flight flag.

### Fix: long-lived chunk-worker with per-cell bitmap cache

- One `CachedChunkWorker` for the whole session
- `init(cellSize, atlasSize)` once on start
- `addSource(cellId, clip)` per stage — decodes the ONE new clip
  into bitmaps, stores under cellId
- `buildChunk(cellOrder, frameStart, frameEnd, cols, rows)` —
  composites from cached bitmaps, encodes one chunk
- Worker yields inside decode loop (every 30 frames) so it doesn't
  starve render
- Build queue: simple drain loop with `pendingStage` flag, no
  recursion (eliminates the race)

### Results (two runs, consistent)

| stg | K | fps | score | streak | max | cam drops | gap | decode |
|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 59 | 0 | 0-1 | 32-40 ms | 1-3 | 0 ms | 1.3 s |
| 2 | 2 | 57 | 1-3 | 1-4 | 48-52 ms | 0 | 1.3 s | 1.3 s |
| 3 | 3 | 57 | 9-15 | 1-3 | 78-88 ms | 0 | 1.3 s | 1.3 s |
| 4 | 4 | 57 | 2 | 1-2 | 51-53 ms | 0 | 1.3 s | 1.3 s |
| 5 | 5 | 57 | 5-6 | 1-2 | 63-80 ms | 0 | 1.3 s | 1.2-1.3 s |
| 6 | 6 | 57 | 1-8 | 1 | 51-74 ms | 0-2 | 1.2-1.3 s | 1.2-1.3 s |
| 7 | 7 | 58 | 1-3 | 1-2 | 49-57 ms | 0 | 1.2-1.3 s | 1.2-1.4 s |
| 8 | 8 | 56-57 | 9 | 1-3 | 80-83 ms | 0-2 | 1.2-1.4 s | 1.2-1.3 s |
| 9 | 9 | 56-60 | 0-9 | 0-1 | 28-73 ms | 0 | 1.2-1.3 s | 1.2-1.6 s |

- **Recording is smooth across all 9 stages.** 56-60 fps, jankScore
  mostly 0-15, max frame 28-88 ms. Camera captures at full rate
  with 0-3 drops per take. Compare to broken 18g's catastrophic
  stage 4 (score 31952, max 550 ms, fps 8.6).
- **Session: ~68-69 s** for 9 takes (vs 18c's 75 s mono). Similar
  total time but dramatically smoother per-frame.
- **Peak heap: 10 MB.** OPFS-backed bitmaps keep memory bounded
  through the whole session.
- **Gap between takes: ~1.3 s.** This is the synchronous
  `addSource()` decode awaited before next stage starts.

### What this validates

- **OPFS lo-fi streaming + cached chunk-worker + chunked builds +
  overlap = production-grade smoothness.** All major architectural
  pieces composed end-to-end.
- **Per-cell bitmap caching in the long-lived worker is critical.**
  Without it, re-decoding all sources every build catastrophically
  contends with capture (the original 18g result).
- **`setTimeout(0)` between encode chunks is sufficient yield.**
  Decode loop also yields every 30 frames inside the worker.

### Remaining gap to close

The 1.3 s decode wait between takes is the next obvious win. Could
be:
- Backgrounded (start next take immediately, decode in parallel) —
  introduces "newest cell not yet in atlas builds" state, manageable
- Streamed (decode chunks-of-frames at a time, build chunks as soon
  as their frames are ready) — more code

Not done in v1.

## Note for eddy implementation

- **Use a long-lived `CachedChunkWorker` for the whole session.**
  Init once, `addSource` per new clip, `buildChunk` per chunk.
  Caching the per-cell decoded bitmaps avoids the linear-N
  re-decode contention that broke the first 18g attempt.
- **Yield inside the worker's decode loop too** (every ~30 frames).
  Workers compete with capture pipeline for hardware decode units;
  tight decode loops there cause main-thread jank even though the
  work is off-thread.
- **The build queue should be a simple drain loop with a
  `pendingStage` flag, not a recursive promise chain.** Avoids the
  "in-flight already exists" race when stages stack quickly.
- **The synchronous decode-await between stages is a UX cost
  (~1.3 s gap).** Worth a future spike to background it; the
  per-recording experience is otherwise smooth.

## Caveats

- v1 doesn't decode the built atlases back into cells. Cells always
  render from OPFS. The atlas swap-back path is covered by 16.
- Same 6 s takes / 9 stages limitation as the rest of the series.
- 1-column-N-rows atlas geometry (vertical strips); production would
  use container-aligned geometry (11).

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
TIMEOUT_MS=600000 PORT=<port> experiments/harness/run.sh 18g_progressive-overlap-chunked
```
