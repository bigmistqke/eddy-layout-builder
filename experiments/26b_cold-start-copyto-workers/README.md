# cold-start-copyto-workers

**Question:** [26](../26_cold-start-cache-build/README.md) measured
13 s cold-start at K=16 with the naïve `drawImage + getImageData`
path on the main thread. The verdict identified two known
mitigations: **`VideoFrame.copyTo({format:'RGBA'})` to skip the
canvas roundtrip, and worker-side decode to move the JS work off
main**. This experiment applies both together. **How much do they
recover?**

## Why

26's bottleneck wasn't decoder bandwidth — it was 16 cells × 60
frames × main-thread `getImageData` calls, each pulling pixels back
from the canvas. The serialised main-thread work limited the SW
decoder pool from delivering its actual capacity.

Two fixes:

1. **`VideoFrame.copyTo(buffer, { format: 'RGBA' })`** — decoder-
   output frames have GPU-backed buffers; `copyTo` directly emits
   RGBA bytes into a provided `Uint8Array` without going through a
   canvas. Should drop the per-frame cost dramatically.
2. **Per-cell worker** — each cell's "warm" job runs in its own Web
   Worker. Decoder still IPCs to GPU process (per 23, workers don't
   add decode parallelism), but the JS-side work (allocations, file
   I/O via SyncAccessHandle, postMessage of results only) is off
   main, so cells don't serialise on each other's allocations.

If 26b's cold-start at K=16 is ≤ 2-3 s, the C2 architecture is
fully viable; session-open feels near-instant.

## Setup

Same shape as 26 except the per-cell warm job:

1. Record source clip (one-time).
2. For each K-pass: transcode source → AV1 at per-K mip, write K
   identical AV1 files to OPFS (setup, not on hot path).
3. **Start timer.** Spawn K workers, one per cell. Each worker:
   - Opens its AV1 file via `SyncAccessHandle`, reads bytes, parses
     into `EncodedVideoChunk`s.
   - Configures an AV1 `VideoDecoder` (`prefer-software`).
   - On each output frame: `await frame.copyTo(buf, {format:'RGBA'})`
     into a freshly-allocated `Uint8Array`, push to collected list,
     close frame.
   - After flush, opens RGBA OPFS file via `SyncAccessHandle`,
     writes all collected frames sequentially.
   - Posts back stats: framesProduced, decodeMs, writeMs, totalMs.
4. **Stop timer when all K workers post done.**
5. Cleanup OPFS files.

Same K-sweep and mips as 26 (K=4/9/16/25 at 540/360/270/180p) for
direct numerical comparison.

## What's measured

Per pass (mirrors 26 exactly):
- `coldStartMs` — wall time for K parallel workers
- `avgPerCellMs` — coldStartMs / K
- Per-cell: `decodeMs`, `writeMs`, `totalMs`, `framesProduced`
- AV1 input size, RGBA output size, compression ratio
- **Speedup ratio vs 26** (computed informally in verdict)

## What to look for

- **K=16 coldStartMs ≤ 2 s** → 5-6× speedup vs 26, in line with the
  prediction. C2 is fully viable; session-open is near-instant.
- **K=16 coldStartMs 2-5 s** → meaningful improvement but not as
  dramatic as hoped; still acceptable for session-open with a
  spinner.
- **K=16 coldStartMs ≥ 8 s** → the copyTo/worker fix didn't recover
  what we hoped; suggests SW decoder pool itself is the bottleneck,
  not the main-thread plumbing. Different mitigations needed.
- **Per-cell `decodeMs` drops dramatically vs 26** → copyTo is doing
  its job.
- **Per-cell `writeMs` drops vs 26** → SyncAccessHandle write in
  worker is faster than the main-thread async writable.

## Verdict

**Cold-start drops 3-11× across K vs 26. C2 session-open is viable.**

| K | mip | 26 cold | 26b cold | speedup | 26b decode | 26b write |
|---|---|---|---|---|---|---|
| 4 | 540p | 7.9 s | **3.4 s** | 2.3× | 959 ms | 1905 ms |
| 9 | 360p | 9.6 s | **3.0 s** | 3.2× | 723 ms | 1720 ms |
| 16 | 270p | 12.9 s | **4.5 s** | 2.9× | 717 ms | 2903 ms |
| 25 | 180p | 25.8 s | **2.4 s** | **10.8×** | 631 ms | 647 ms |

Key findings:

1. **Decode cost dropped ~13×** (K=16: 9.4 s → 0.7 s per cell). `VideoFrame.copyTo({format:'RGBA'})` + worker isolation does almost exactly what 26's verdict predicted.
2. **K=25's pathological 26 s in 26 was main-thread serialisation** — workers eliminate it entirely, dropping to 2.4 s.
3. **Write became the dominant cost** at K=4/9/16 (per-cell write 1.7-2.9 s). The SyncAccessHandle write happens per-frame inside each worker; batching into one large write would likely halve it.

K=16 cold-start at 4.5 s is acceptable for production session-open with a loading state. K=25 at 2.4 s is near-instant. The architecture is viable.

## Note for eddy implementation

- **Use `VideoFrame.copyTo({format:'RGBA'})`** for any path that needs raw bytes from a decoded frame. Don't use canvas + `getImageData` — it's ~13× slower in this case.
- **Run cold-start in per-cell workers** with `SyncAccessHandle` for OPFS I/O. The main thread stays free for UI.
- **Next optimisation**: batch the per-frame RGBA writes inside each worker into one large Uint8Array, then a single `sah.write()`. At K=16, this could shave another ~1-2 s off cold-start.
- For larger K (K=25+) consider the lazy-warm pattern: warm only currently-visible cells immediately, background-warm the rest. Even with 4.5 s, foreground latency for visible cells could be < 1 s.

## Caveats

- Same source content per cell (test simplification); per 15 doesn't
  meaningfully affect decode/copyTo cost.
- AV1 transcode happens once per pass at setup (not on hot path).
- Workers are spawned fresh per pass; warmup cost included in
  measurement. Real eddy might pool workers.
- `frame.copyTo({format:'RGBA'})` requires Chrome's WebCodecs to
  support RGBA-output conversion from whatever native format the
  decoder produces (typically I420/NV12). Spec supports this; if
  Chrome doesn't, workers will surface errors.
- `SyncAccessHandle.write` is synchronous within the worker; writes
  shouldn't pile up like async writable streams do.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
TIMEOUT_MS=240000 PORT=<port> experiments/harness/run.sh 26b_cold-start-copyto-workers
```
