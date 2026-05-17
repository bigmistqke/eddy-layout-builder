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
