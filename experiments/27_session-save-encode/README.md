# session-save-encode

**Question:** in the C2 architecture, when a session is saved (or a
modified cell is finalised), the raw RGBA frames need to be encoded
back to AV1 (or VP9) for the persistent canonical. **How long does
that encode take for K cells, and how does it compare across codecs?**

## Why

Per 20: AV1 encode is ~32 fps and VP9 encode is ~43 fps at 720p on
this device. Smaller mips probably encode faster. The choice of
codec for the persistent canonical matters:
- AV1 produces smaller files (per 20: 141 KB/s at 720p vs VP9's 251 KB/s)
- AV1 encode is slower
- Trade-off depends on whether session-save is "background, untimed"
  or "user-facing, blocking"

This experiment closes Q2 from the design-doc list (session-save UX
latency) and refines Q3 (storage cost per codec).

## Setup

For each pass:

1. Record VP8 source (shared across passes).
2. Pre-decode source → K identical raw RGBA bitmap streams at per-K
   mip (one set in memory; cells share content per 15's verdict).
3. For each codec in `[av1, vp9]`:
   - **Sequential** mode: encode cell 0, then cell 1, ..., then cell K-1.
     Measures the worst-case "one encoder at a time" cost.
   - **Parallel** mode: spawn K encoders concurrently, await all.
     Measures parallel best-case (if the codec service serialises,
     parallel ≈ sequential).
   - Per-codec output bytes per cell, encode wall time.

Per-K mips (matches 24f-h / 26):

| K | mip |
|---|---|
| 4 | 540p |
| 9 | 360p |
| 16 | 270p |
| 25 | 180p |

## What's measured

Per (K, codec, mode) cell:
- `encodeMs` — wall time for the K-cell encode (whole pass)
- `bytesPerCell` — output file size, codec
- `framesPerCell` — sanity check
- Per-cell breakdown (encode time, output size)

## What to look for

- **VP9 parallel ≤ AV1 parallel** by ~2× per 20's encode-fps numbers
- **Parallel ≈ sequential / N for some N** — if N is small, the encoder
  service serialises; if N is large (close to K), encoders truly run
  concurrently
- **AV1 bytes 30-60% smaller than VP9 bytes** per 20's per-second numbers
- **K=16 AV1 parallel encode ≤ 2 s** → session-save can feel
  near-instant
- **K=16 AV1 parallel encode ≥ 10 s** → save needs a background
  job pattern (toast-on-complete, not blocking UI)

## Verdict

**Parallel encoders genuinely parallelise; AV1 trades speed for size, VP9 trades size for speed; both are fast enough at typical session-save K.**

| K | mip | codec | sequential | parallel | KB/cell | total KB |
|---|---|---|---|---|---|---|
| 4 | 540p | AV1 | 5.3 s | **4.2 s** | 232 | 930 |
| 4 | 540p | VP9 | 3.5 s | **2.5 s** | 279 | 1115 |
| 9 | 360p | AV1 | 8.2 s | **2.9 s** | 94 | 843 |
| 9 | 360p | VP9 | 5.2 s | **1.8 s** | 131 | 1177 |
| 16 | 270p | AV1 | 6.0 s | **2.1 s** | 50 | 792 |
| 16 | 270p | VP9 | 5.2 s | **1.7 s** | 73 | 1170 |
| 25 | 180p | AV1 | 5.1 s | **1.7 s** | 22 | 547 |
| 25 | 180p | VP9 | 3.7 s | **1.3 s** | 36 | 887 |

Findings:

1. **Parallel encode actually parallelises** at this device's encoder service. K=9 AV1 parallel is 2.9 s vs 8.2 s sequential (2.8× faster). Encoders pipeline differently than decoders (23/24-series showed decoders serialise on GPU IPC) — encoder service apparently does meaningful concurrency.
2. **VP9 is 20-30% faster than AV1** at every K and mip.
3. **AV1 files are 17-39% smaller than VP9** (and the gap widens at smaller mips).
4. **At K=16: AV1 parallel = 2.1 s, VP9 parallel = 1.7 s.** Fast enough for a session-save that the user perceives as near-instant; trivially fine as a background task.

Total session-save size is ~0.5-1.2 MB regardless of codec choice — the canonical storage premise of C2 holds either way.

## Note for eddy implementation

- **AV1 for canonical storage, VP9 acceptable as fallback** — AV1's smaller-file win matters across many saved sessions; the 2.1 s vs 1.7 s difference at K=16 doesn't.
- Session-save can be parallel (~2 s) or background-incremental (encode while user keeps working). Both feasible.
- Cell-level save (one cell modified, encode just that cell) would be ~1/K of these numbers — sub-second for K=16 cells. Very cheap.
- Per-cell file sizes scale with mip area: 540p ≈ 230-280 KB, 270p ≈ 50-73 KB, 180p ≈ 22-36 KB for 2 s of content. Linear in seconds, so 6 s would be 3× these.

## Caveats

- All K cells share the same source content. Cross-cell entropy
  isn't load-bearing for encode (analogous to 15's finding for
  decode/atlas).
- Encoders run on main thread for this measurement. Worker-side
  encode might pipeline differently; not tested.
- Pre-decode RGBA happens in-memory, not from OPFS. Real session-save
  would read RGBA from OPFS first — small extra cost ignored here.
- Single test clip per pass (60 frames at the per-K mip). Real eddy
  cells may be 6-30 s; encode wall-time scales with frame count.
- Sequential vs parallel uses the same encoders just scheduled
  differently — codec service behaviour determines whether parallel
  actually scales.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
TIMEOUT_MS=480000 PORT=<port> experiments/harness/run.sh 27_session-save-encode
```
