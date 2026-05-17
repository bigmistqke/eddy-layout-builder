# worker-rebuild

**Question:** [24c](../24c_incremental-rebuild/README.md) showed inline
on-main-thread atlas rebuild fails — rebuild takes 9-20 s under
playback contention (vs 1.5 s uncontended), and the rebuild operation
itself janks rAF even at low edit rates. **Does moving the rebuild
(decode source + composite + AV1 encode) into a Web Worker recover
near-uncontended build times and let the eventually-consistent atlas
pattern actually work?**

## Why

24c left the hybrid architecture unvalidated because no rebuild
scheduler kept up. The natural next move is 18g's worker pattern
(originally proved for VP8) ported to AV1.

But [23](../23_sw-workers/README.md) taught us something subtle: in
Chrome (≥95), `VideoDecoder` *and* `VideoEncoder` run in the GPU
process regardless of whether the JS that drives them lives on main
or in a worker. So the worker frees the main thread but **may not**
unblock the GPU-process contention between the rebuild's encode and
playback's decode. That's the open question.

If worker rebuild stays close to uncontended cost → main-thread
blocking was the dominant cost → hybrid pattern is back on track.

If worker rebuild is still slow → GPU-process contention is the
dominant cost → we need a different lever (smaller atlases, idle-
only rebuild, speculative pre-build, codec swap, etc).

## Setup

Same baseline as 24c: K=16, M=4 atlases (2×2 cells × 270p AV1),
per-cell AV1 mip prepared up front. Render loop drives M atlas
decoders + D dirty per-cell decoders.

Key change: replace 24c's inline `buildAtlas(source)` with a
`buildAtlasInWorker(source)` call. The worker:
1. Receives the source clip's `VideoDecoderConfig` + raw chunk bytes
   once at startup (serialized via `ArrayBuffer` transfer).
2. Per build request, decodes the source in an OffscreenCanvas →
   composites tiles → encodes via `VideoEncoder` (AV1) → posts back
   the encoded chunks + config + buildMs.
3. Main thread builds a fresh `VideoDecoder` from the returned
   asset and swaps it in.

Same edit-rate sweep R ∈ {0.25, 0.5, 1.0, 2.0} edits/s. 20 s per
pass. Direct numerical comparison against 24c.

## What's measured

Per pass (same shape as 24c):
- Render fps + standard JankRecorder stats
- Long-tasks observed
- Aggregate decode fps (atlas + per-cell)
- D over time — max, mean, p95
- Rebuilds completed during the run
- **Mean rebuild wall time (worker-side)** — the key number
- Edits applied vs skipped

## What to look for

Direct ratios vs 24c:

- **rebuildMs at R=0.25 ≈ 1500-2800 ms** (matches 24a uncontended)
  → worker successfully isolates rebuild from playback. Hybrid
  architecture viable.
- **rebuildMs at R=0.25 still ~9-20s** → GPU-process contention
  dominates; the worker hop bought nothing. Need a different
  approach.
- **Render fps stays clean across rates** → worker rebuild lets
  playback survive
- **D stays bounded** at moderate rates (R ≤ 1.0?) → eventually-
  consistent pattern works

Other things to watch:
- **Long-tasks observed should drop dramatically** vs 24c (main
  thread no longer doing the encode work)
- **Swap-hitch on rebuild completion** — does swapping the atlas
  decoder show up as a single visible jank spike per rebuild?
- **Memory** — the worker's intermediate buffers live in worker
  process; chunks are transferred not copied where possible

## Caveats

- The source clip's chunk bytes are sent to the worker once, copied
  on transfer. For multi-second clips at 720p VP8 that's a few MB —
  acceptable startup cost, not in the rebuild loop.
- Each rebuild call sends only command bytes; the worker reuses its
  cached source.
- Atlas-swap on rebuild completion is naive (close old decoder,
  open new). No pre-warm or VideoFrame-hold (per 14/16). Swap
  hitches are a finding, not a fixed parameter.
- The encoded chunks come back from the worker as raw `ArrayBuffer`s
  and are rebuilt as `EncodedVideoChunk`s on main; the main-thread
  cost of that is small but non-zero.
- Same source-content limitation as 24c (no real new content
  integrated per rebuild — measuring cost + coordination, not
  semantics).
- A single worker is reused for the whole pass (one rebuild at a
  time). Parallel rebuilds in multiple workers is a possible follow-
  up if serial throughput isn't enough.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
TIMEOUT_MS=600000 PORT=<port> experiments/harness/run.sh 24d_worker-rebuild
```
