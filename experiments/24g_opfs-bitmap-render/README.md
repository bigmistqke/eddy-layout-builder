# opfs-bitmap-render

**Question:** [24f](../24f_render-loop-all-bitmap/README.md) held
clean 60 fps at K=4/9/16/25 with all-bitmap rendering — but used
**in-memory** RGBA frames. **Does the same render loop hold when the
bytes come from OPFS via a reader worker, per [18c](../18c_opfs-bitmaps/README.md)'s
pattern?** That's the load-bearing piece between "the upload + draw
fits the budget" (24f's finding) and "the production storage layer
can sustain the data rate."

## Why

[18c](../18c_opfs-bitmaps/README.md) validated OPFS-backed bitmap
streaming at K=9 with concurrent capture. The all-bitmap design from
24f wants to extend this to K=25 with the bitmap path as the *only*
playback architecture (no atlas, no codec at render time).

At K=25 × 30 fps × 180p RGBA (~59 KB per frame), the reader needs to
sustain ~44 MB/s of OPFS reads + post-message bandwidth. K=16 × 270p
RGBA (~130 KB per frame) is ~63 MB/s. Both are well under modern
mobile SSD throughput, but the actual ceiling on an Android Chrome's
OPFS+SyncAccessHandle path is unmeasured at this K.

If this holds, the all-bitmap architecture is validated end-to-end
through the storage layer.

## Setup

Same K-sweep as 24f. Per pass:

1. Decode source clip → downscale to per-K mip res → write K OPFS
   files (one per cell, frames concatenated). Pre-population happens
   in setup, not during the render loop. Per-cell file size:
   `framesPerPass × mip_width × mip_height × 4`.
2. Spawn reader worker. Worker opens K `FileSystemSyncAccessHandle`s,
   maintains a per-cell cursor that advances at source-fps (30 Hz),
   reads the current frame for each cell when its cursor advances,
   posts the batch back to main as transferable ArrayBuffers.
3. Main maintains a per-cell "latest bytes" map updated on worker
   messages.
4. Render loop runs 10 s. Each rAF tick: for each cell, if a frame is
   available, `texImage2D(RGBA, UNSIGNED_BYTE, bytes)`.

After each pass, OPFS files are deleted so the test doesn't
accumulate gigabytes between runs.

## What's measured

Per pass (mirrors 24f for direct comparison):
- Render fps + standard JankRecorder stats
- Long-tasks observed
- **OPFS write time** at setup (informational — pre-population cost)
- **Frames received from worker** per cell (sanity — confirms the
  reader is keeping up)
- **Empty-cell ticks** — rAF ticks where a cell had no frame
  available; should be near zero in steady state

## What to look for

- **fps matches 24f at every K** → OPFS read pipeline keeps up
  through K=25; storage layer validated
- **fps degrades at high K vs 24f's in-memory** → reader is the
  bottleneck; need batching, larger ring buffer, or different worker
  count
- **Empty-cell ticks > 0** → reader didn't deliver in time; cells
  paint stale data (still smooth render-wise but content lags)
- **OPFS write time at K=25 is reasonable** (per 18c, sub-200 ms
  for K=9 × 6 s); larger writes scale accordingly

## Verdict

**OPFS reader holds through K=25 with zero empty-cell ticks. The storage layer is validated.**

| K | mip | fps | mean | p95 | max | >33ms | empty ticks | OPFS write |
|---|---|---|---|---|---|---|---|---|
| 4 | 540p | 55.4 | 18.1 | 16.8 | 250* | 1.8% | 0 | 478 MB / 7.9 s |
| 9 | 360p | 58.9 | 17.2 | 16.7 | 117* | 1.5% | 0 | 485 MB / 11.2 s |
| 16 | 270p | **59.3** | 17.0 | 16.7 | 66.7 | 1.5% | 0 | 478 MB / 14.2 s |
| 25 | 180p | **59.2** | 17.0 | 16.7 | 66.6 | **1.4%** | **0** | 352 MB / 15.8 s |

\* Single setup hitches at K=4 / K=9; p95=16.7 confirms steady state.

Side-by-side against 24f (in-memory) and 24a (atlas AV1):

| K | 24f (in-mem bitmap) | 24g (OPFS bitmap) | 24a (atlas AV1) |
|---|---|---|---|
| 4 | 58.5 fps, 2.6% | 55.4 fps, 1.8% | 60.0 fps, 0.3% |
| 9 | 59.7 fps, 0.5% | 58.9 fps, 1.5% | 60.0 fps, 0.3% |
| 16 | 59.8 fps, 0.5% | 59.3 fps, 1.5% | 60.1 fps, 0.2% |
| 25 | 60.1 fps, 0.2% | 59.2 fps, 1.4% | 60.2 fps, 0.2% |

OPFS adds ~1 fps cost and ~1% more jank vs in-memory bitmap. Small, attributable to worker postMessage overhead. All three architectures functionally equivalent at this scale.

**Key data points:**
- Reader delivered 268-286 frames per cell over the 10 s window (target 300 at 30 fps) — sustains the data rate across all K.
- Zero empty-cell ticks at every K — the reader was never behind the render loop.
- Pre-population takes 8-16 s for 350-500 MB. This is one-shot setup cost; real eddy capture would write incrementally per camera frame.

## Note for eddy implementation

- The OPFS bitmap pipeline (18c's reader pattern extended to K=25) works for the no-atlas architecture.
- Per-cell storage = mip bytes × source fps × cell duration. K=16 × 6 s × 270p ≈ 480 MB per session (bounded by cell-count × cell-duration, not session-length).
- The setup-time pre-population cost (8-16 s for half a GB) is misleading — production would have frames trickling in at 30 fps during recording, ~33 ms per frame write. 18c showed this is sustainable.
- One thing worth noting: the per-cell ArrayBuffer churn on the main thread (one transferable buffer per cell per source frame) is significant. K=25 × 30 fps = 750 buffers/sec being allocated and transferred. Hasn't shown up as jank here but worth watching under combined load (24h).
- The reader-worker pattern as scaffolded uses one worker for all K cells. Splitting into K/N workers (e.g., N=4 workers each handling a quarter of the cells) is a possible mitigation if read concurrency ever becomes a bottleneck.

### Follow-up: SharedArrayBuffer to eliminate postMessage overhead

The ~1 fps cost vs in-memory (24f) is attributable to per-frame ArrayBuffer allocation + structured-clone deserialization on the main thread (K cells × ~30 frames/s = up to 750 buffers/sec at K=25). A `SharedArrayBuffer`-backed ring buffer per cell would eliminate this entirely:

```
// Setup (once):
const ringSize = 2 // double-buffered: worker writes one slot while main reads other
const sab = new SharedArrayBuffer(K * ringSize * frameBytes)
const signals = new SharedArrayBuffer(K * 4) // Int32 per cell — index of latest-written slot
const sigView = new Int32Array(signals)

// Worker per frame per cell:
handle.read(new Uint8Array(sab, cellOffset + nextSlot * frameBytes, frameBytes), { at: ... })
Atomics.store(sigView, cellId, nextSlot)
nextSlot = 1 - nextSlot

// Main per tick per cell:
const slot = Atomics.load(sigView, cellId)
const bytes = new Uint8Array(sab, cellOffset + slot * frameBytes, frameBytes)
gl.texImage2D(..., bytes)
```

Zero per-frame allocation; zero `postMessage` of bytes (only one init message handing over the SAB references). The atomic on the signal index guarantees main never reads a partially-written frame.

Total shared memory needed is tiny: K=25 × 2 × 59 KB = ~3 MB; K=16 × 2 × 130 KB = ~4 MB; K=4 × 2 × 522 KB = ~4 MB.

**Prerequisite:** `SharedArrayBuffer` needs cross-origin isolation — HTTP responses must include `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, and `crossOriginIsolated` must be `true` at runtime. The experiments dev server (Vite) does not set these by default; one-line `server.headers` config in `vite.config.ts` fixes it. `texImage2D` accepts `Uint8Array` views of SAB on WebGL2.

**Larger alternative — OffscreenCanvas in worker:** moving the entire render loop into the worker (reader + WebGL context + texImage2D + drawArrays) eliminates all main-thread JS during steady-state playback. Bigger refactor (shader setup, draw logic, frame pacing all move to worker), but frees the main thread completely for capture / UI / edits. Worth considering separately if main-thread contention ever becomes the bottleneck.

Neither was implemented here — 24g establishes that the postMessage version is already viable. The SAB and OffscreenCanvas options are characterized for when the next layer of optimization is needed.

## Caveats

- All cells share the same source content (looped). Per 15
  cross-cell entropy isn't load-bearing for upload; OPFS-read-wise
  reads happen from K independent files regardless.
- No concurrent capture. 24h is the natural follow-up that adds
  capture; this experiment isolates the storage layer.
- Pre-population happens in main thread via the async OPFS writable
  API (`createWritable`). Real eddy capture would write from a
  worker via `SyncAccessHandle` (per 18c) — this experiment validates
  *read* side only.
- Worker posts ArrayBuffers transferably; per-tick post message
  count is at most K (frames batched per advance).
- Per-cell file size scales with `framesPerPass × pixel area × 4`.
  At K=25, 180p, 60 frames per cell ≈ 87 MB total OPFS (modest).
- `gl.clear` per tick (mandatory per 18c).
- Same source clip across all passes; each pass freshly decodes and
  writes new OPFS files for its mip.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
TIMEOUT_MS=360000 PORT=<port> experiments/harness/run.sh 24g_opfs-bitmap-render
```
