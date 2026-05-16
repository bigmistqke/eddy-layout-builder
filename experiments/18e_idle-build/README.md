# yielding-build

**Question:** if the atlas build is the source of jank during
recording (18c), does *yielding between every frame of the build*
soften the contention enough to keep render + capture smooth?
A pragmatic stand-in for the "temporal-chunks" / `requestIdleCallback`
ideas — the simplest way to make the worker polite without
restructuring the build output.

## Why

[18c](../18c_opfs-bitmaps/README.md) showed the rebuild worker
running at full speed contends with capture + render to produce
heavy jank (score 27 000 in the worst stage). The original
`docs/video-playback-scaling.md` design (candidate 2) proposed
temporal chunking — split the song's atlas into N time-slices,
each built independently, each small.

This experiment tests the simplest variant: build the same source
as **one monolithic atlas** vs **3 sequential 2 s chunks**, each
concurrent with the production hot-path (capture + render of K=8
OPFS-streaming cells). Measure jank, build time, and the
"chunks-ready by time T" progression.

## Setup

For each pass:

1. **Pre-record** 8 clips, write raw RGBA per cell to OPFS (per 18c).
2. **Start rendering** 9 cells: 8 OPFS-streaming + 1 live camera.
3. **Start capture** (`MediaRecorder` for `passSeconds`).
4. **Kick off build** in the pass's mode.
5. **Measure** until build completes or pass deadline: full
   JankReport per harness/jank.ts, build wall-clock per chunk,
   total build wall-clock, longtasks.

Three passes:
- **Baseline (no build)** — `render + capture only` jank floor.
- **Mono atlas (= 18c's worker)** — full 6 s atlas built in one
  worker job. Comparison.
- **Temporal chunks (3 × 2 s)** — same source, split into 3
  sequential chunks (separate worker per chunk, each a standalone
  VP8 atlas). Optional inter-chunk yield via `setTimeout(0)` so
  the main thread gets breathing room between chunks.

## What to look for

- **Baseline jank** = unavoidable render+capture floor
- **Mono jank** ≫ baseline (we already know from 18c)
- **Chunked jank** ≈ baseline → smaller chunks soften contention
  enough to be invisible; *or* ≈ mono → same total work, no win
- **Chunks-ready progression** — at what wall-clock time is each
  chunk usable? Lets us reason about "play from chunk 0 while
  chunk 2 still builds" pattern
- **Build total time** — chunked should be similar to mono +
  per-chunk worker spawn overhead (~50 ms each). If much worse,
  chunking isn't viable for in-session.

## What this would unlock if it works

- In-session atlas builds become *incrementally available* — first
  chunk done = first slice of timeline playable from atlas
- Each individual contention window is shorter — less visible
  freeze per chunk
- Smaller chunks fit between takes more easily (a 2 s chunk
  builds in 2.4 s, fits in any take's 6 s window)

## What this doesn't solve

- Total CPU/GPU work is unchanged — total contention time across
  the session may be the same
- Cell-change invalidation still dirties **all** chunks of the
  song (a cell's content spans the whole timeline) — so we still
  rebuild the whole atlas, just in pieces

## Verdict (2026-05-16 · Galaxy A15 · Android 10 · Chrome 148)

**Decisive: chunked builds with yields are indistinguishable from
baseline. The rebuild-during-record contention from 18c collapses.**

Two runs, identical shape:

| pass | mean | p95 | p99 | max | over33 | streak | **jankScore** | build ms |
|---|---|---|---|---|---|---|---|---|
| baseline (run 1) | 16.7 | 19.9 | 23.0 | 38.4 | 1 | 1 | **0.0** | — |
| mono (run 1) | 18.0 | 21.9 | 46.0 | 286.4 | 16 | 6 | **162.7** | 4494 |
| chunked (run 1) | 16.8 | 19.7 | 24.7 | 38.9 | 2 | 1 | **0.1** | 1157+1166+1073 = 3396 |
| baseline (run 2) | 16.7 | 19.7 | 22.8 | 31.1 | 0 | 0 | **0.0** | — |
| mono (run 2) | 18.1 | 20.5 | 58.2 | 266.8 | 16 | 2 | **146.0** | 4445 |
| chunked (run 2) | **16.7** | **19.6** | **23.1** | **29.2** | **0** | **0** | **0.0** | 1173+1177+1145 = 3495 |

Three findings:

1. **Chunked render jank ≈ baseline.** Score 0.0-0.1, max 29-39 ms,
   zero or one frame over 33 ms. Visually indistinguishable from "no
   build at all." The yields between chunks give the browser
   scheduler enough slack to keep render+capture smooth.
2. **Mono has clear hitches.** Score 146-163, max 266-286 ms (~8
   visible blank frames per pass), streak of 2-6 consecutive bad
   frames. Same 18c jank pattern, isolated and reproducible.
3. **Chunked is FASTER than mono in total** (~3.4 s vs ~4.5 s; ~25%
   speedup). Unexpected — I'd assumed yields cost time. Likely the
   per-chunk encoder init+teardown amortises differently, or the
   scheduler's breathing room pays back in throughput.

`longtasks=0` on both runs, despite mono's clear 266-286 ms freezes.
PerformanceObserver longtask API on Android Chrome 148 doesn't seem
to catch frame-time spikes in this code path; per-frame timing
(rAF deltas) is the reliable signal here.

## Note for eddy implementation

- **Build atlases in temporal chunks of ~1-2 s each.** Each chunk is
  a standalone composite (independent decode+encode, ~1.1 s for ~60
  frames). Sequence them in a worker (or main thread) with yields
  in between.
- **`await new Promise(r => setTimeout(r, 0))` between chunks is
  enough.** Schedule it as cooperatively as possible; the browser's
  scheduler will interleave the work with rAF and capture without
  any explicit "background priority" hint needed. (We didn't even
  need `scheduler.postTask({priority:'background'})` — plain
  setTimeout-0 worked.)
- **Don't monolithic-build during recording.** 18c + 18e together
  show the architectural penalty: ~150-point jankScore, sustained
  multi-hundred-ms freezes. Always chunk + yield, even when the
  user isn't recording (cheaper for them too).
- **Pre-decode source cells once, build many chunks from the same
  pre-decoded bitmaps.** The chunk-composer in this experiment
  decodes each source clip once, then assembles any frame-range
  on demand. Re-decoding per chunk would be wasteful; share the
  decoded bitmap arrays across chunks of the same source.
- **The atlas stays as the persistent / export form.** This
  experiment only changes *how* it's built, not what it is. Atlas
  on disk = small (per 13: 791 KB for 4 s). Cold-start still
  works the same.

This essentially resolves the 18c open question. Combined with
18d (pure streaming for K≤4, atlas grouping for K>4), the
architecture for the recording flow is now:

  - **K ≤ 4 cells**: stream each cell directly from VP8, no atlas
    (per 18d)
  - **K > 4 cells**: build atlas in chunks with yields during
    rebuilds (per 18e here), render decodes the atlas

## Caveats

- v1 only does temporal split; no per-cell + per-time grid
  (that's a 2D follow-up if temporal alone is promising)
- v1 uses 3 chunks fixed; tunable chunk size is a follow-up
- The renderer here doesn't actually swap to chunks — it stays on
  OPFS bitmaps. We're measuring *build* jank, not the eventual
  chunk-decode render path.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
TIMEOUT_MS=600000 PORT=<port> experiments/harness/run.sh 18e_idle-build
```
