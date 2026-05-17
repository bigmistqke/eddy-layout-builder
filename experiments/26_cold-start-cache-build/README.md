# cold-start-cache-build

**Question:** in the C2 architecture (AV1 in OPFS for persistence,
raw RGBA in OPFS as working cache), opening a session has to decode
K AV1 files and write K raw RGBA caches before playback can start.
**How long does that cold-start take for K ∈ {4, 9, 16, 25} cells in
parallel on this device?** And what's the AV1 storage cost it
delivers in exchange?

## Why

24f / 24g / 24h validated the playback side of the all-bitmap
architecture. C2 (AV1 canonical + RGBA cache) extends that to use
AV1 as the persistent storage, with the RGBA cache rebuilt on-demand
when sessions open. The size win is significant (~3 MB vs ~480 MB
per K=16 session, per the 20-series compression numbers), but only
viable if cold-start latency is acceptable for session open.

Per 20: AV1-SW solo decodes ~263 fps at 270p; pool of 4 SW decoders
aggregates ~551 fps. For K=16 × 6 s clips at 270p = 16 × 180 frames =
2880 frames, the predicted cold-start with 4 concurrent decoders is
~5 s. This experiment measures the actual number, including the
RGBA write to OPFS that the prediction doesn't cover.

## Setup

For each pass:

1. Record a VP8 source clip (one-time per run, shared across passes).
2. Transcode source to AV1 at the per-K mip resolution → in-memory
   chunks.
3. Pre-stage: write K identical AV1 files to OPFS (representing K
   different cells in a real session). Outside the cold-start
   measurement.
4. **Start timer.**
5. For each of K cells in parallel: spawn an AV1 `VideoDecoder`
   (`prefer-software`), read the AV1 file's chunks, decode each
   frame, downscale to RGBA via OffscreenCanvas, accumulate frames,
   write the concatenated RGBA bytes to a per-cell OPFS file.
6. **Stop timer when all K cells finish.**
7. Record: cold-start wall time, AV1 input size per cell, RGBA output
   size per cell, frames produced per cell.

Per-K mips (matches 24f-h):

| K | Grid | Per-cell mip |
|---|---|---|
| 4 | 2×2 | 540p (960×544) |
| 9 | 3×3 | 360p (640×368) |
| 16 | 4×4 | 270p (480×272) |
| 25 | 5×5 | 180p (320×184) |

Cleanup OPFS files between passes.

## What's measured

Per K-value pass:
- `coldStartMs` — total wall time for the K parallel cells to finish
- `avgPerCellMs` — coldStartMs / K (informational; per-cell amortized)
- `framesPerCell` — sanity check that the full clip decoded
- `av1BytesPerCell`, `av1TotalMb`
- `rgbaBytesPerCell`, `rgbaTotalMb`
- `compressionRatio` — rgba / av1, the storage win factor

## What to look for

- **coldStartMs ≤ 1 s at K=16** → session-open feels instant; C2 is
  trivially viable
- **coldStartMs 1-3 s** → session-open has a brief loading state;
  acceptable with a spinner
- **coldStartMs ≥ 5 s** → session-open is heavy enough to feel slow;
  needs amortization (parallel with UI paint, incremental warm, etc.)
- **AV1 size 100-200× smaller than RGBA** → confirms 20-series
  compression numbers; persistent storage win is real
- **coldStartMs scales sub-linearly with K** → SW decoder pool's
  parallelism (per 19d/20b) provides meaningful concurrency benefit
- **coldStartMs scales linearly with K** → effectively serial despite
  parallel-decoder-pool theory; reveals a hidden serialization

## Caveats

- All K cells decode the same source content (test simplification).
  Real eddy cells have different content; per-cell decode cost
  shouldn't depend on content meaningfully.
- AV1 transcode (source → AV1) happens once at setup, not on the hot
  path of cold-start. Real eddy would have AV1 already in OPFS from
  the prior save (covered separately by 27).
- Uses `VideoDecoder.prefer-software` per 20-series — AV1 has no HW
  path on this device.
- Pre-staging the AV1 files into OPFS uses the main-thread async API.
  Read on the hot path stays on main as well (mirrors 24g's setup
  pattern — the decoder reads the AV1 chunks from memory after
  loading them from OPFS once).
- Concurrent decoder count is `K` (all decoders started simultaneously).
  This represents the worst-case "all cells need to be ready ASAP"
  scenario. Real eddy might prefer-just-the-visible-cells strategies;
  not in scope.
- Result.json doesn't include OPFS files (cleaned up at end).

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
TIMEOUT_MS=360000 PORT=<port> experiments/harness/run.sh 26_cold-start-cache-build
```
