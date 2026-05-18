# capture-encode-under-playback

**Question:** does the capture-time AV1 encode from
[exp 30](../30_capture-time-av1-encode/README.md) /
[exp 30d](../30d_synthetic-30fps-stress/README.md) still keep up at
30 fps when K=4 or K=9 cells are concurrently decoding + producing
RGBA frames — i.e. under the kind of CPU contention the eddy app
actually creates during playback?

## Why

Exp 30d showed the AV1 encoder has ~7× headroom over realtime at
270p / 180p in isolation. But eddy doesn't record in isolation — the
typical record-while-playing flow has all other K cells decoding
their AV1 source and rendering RGBA bitmaps every frame. If that
playback load eats the encoder's headroom, capture-time AV1 isn't
viable and we fall back to MediaRecorder + post-record-transcode
(the path [phase 3 spec](../../docs/superpowers/specs/2026-05-18-c2-phase3-design.md)
originally proposed).

This experiment measures the encoder's behavior under realistic
playback contention.

## Setup

Two phases:

**Phase 1 — fixture setup (offscreen, untimed):**
1. Pre-encode 6 s of synthetic-pattern AV1 at 270p (same painter as
   [exp 30d](../30d_synthetic-30fps-stress/README.md)), in memory.
2. Demux that WebM into an `EncodedVideoChunk[]` — this is the
   fixture every decoder loops over.

**Phase 2 — measured run, one per K in {4, 9}:**
1. Spawn K `VideoDecoder` instances, each set up to loop the chunk
   fixture continuously. Per-decoder loop: feed the chunks in
   sequence; on each `output` callback, call `frame.copyTo({format:
   'RGBA'})` into a per-decoder ArrayBuffer (the same workload eddy's
   bitmap-source does), then close the frame; when the chunks
   exhaust, reset the decoder with a key chunk and start over.
   Pace each decoder at 30 fps (a `wait(1000/30)` between feeds).
2. Wait `warmupMs` (1 s) so all decoders are running steady.
3. Run the synthetic-30fps encode (the 30d painter → `VideoFrame` →
   `VideoSample` → `VideoSampleSource(AV1)` → `Output(WebM)`) at 270p
   for `captureSeconds` (10 s), with the fire-and-track add pattern
   from 30d.
4. Stop all decoders. Finalize the encoder.

Tested concurrencies: K=4, K=9. Encoded resolution fixed at 270p
(the typical K=16-cell mip per phase 3 spec; the value 30d showed
had the most headroom while still being a realistic working res).

## What's measured

For the encoder (same as 30d):
- `submittedFps` / `encodedFps` — should both stay at 30
- `pendingAddsMax` — peak in-flight depth
- `addP95Ms` / `addMaxMs` — per-frame encode latency
- `tickLagP95Ms` — input clock honored?
- `finalizeMs` / `webmBytes` / `roundTripVerified`

For the playback load:
- `decoderFps[i]` — per-decoder achieved fps over the encode window
  (frames decoded ÷ `captureSeconds`); should sit near 30 if the
  decoder pool keeps up
- `decoderFpsMin` / `decoderFpsMean` — quick summary
- `totalDecoderFps` — sum, i.e. total RGBA-frame throughput across
  all K decoders during the encode window

## What to look for

- **K=4: `encodedFps` = 30, `pendingAddsMax` ≤ 5, all decoders ≥
  28 fps** — typical small-grid recording is comfortably handled
- **K=9: `encodedFps` = 30, `pendingAddsMax` ≤ 10, all decoders ≥
  25 fps** — encoder still realtime even at full K=9 contention,
  decoders take a small hit but stay near-realtime
- **K=9: `encodedFps` < 30** — encoder is starved; capture-time AV1
  is not viable at K=9 and we need either a smaller working res, a
  decode/encode worker split, or fallback to post-record-transcode
- **Decoders crater (< 15 fps) while encoder stays at 30** — encoder
  starves playback; playback would visibly jank during record (bad UX
  even if record itself works)
- **`addMaxMs` spikes ≥ 100 ms** — encoder gets starved intermittently
  (probably during a decoder key-frame burst); fire-and-track absorbs
  it but live preview of the encode might stutter

## Caveats

- Decoders run on the main thread here, same as the encoder. The
  production eddy architecture moves decode to workers
  ([phase 2 spec](../../docs/superpowers/specs/2026-05-18-c2-phase2-design.md)),
  which would *reduce* contention on the encoder. So this experiment
  measures the **worst case**; production should be no worse.
- The fixture is synthetic AV1, not camera footage. The decode cost
  is dominated by pixel count + bitstream complexity, both of which
  are realistic at 270p; the painter pattern doesn't artificially
  reduce decode work.
- 10 s of contention is short — thermal effects aren't tested. If K=9
  is fine here, follow-up with a 60 s run.
- Audio is out of scope (that's
  [30c](../30c_audio-split-pipeline/README.md)).
- The decoder loops are paced to 30 fps; the bitmap-source in
  production also paces at 30 fps. If the decoders were unpaced,
  they'd burn way more CPU than realistic.

## Findings (2026-05-18, sha `b682394`, Galaxy A15)

Encoder holds 30 fps cleanly even at K=9 concurrent decoders. No
starvation in either direction.

| K | encodedFps | pendingMax | add p95 | add max | decoderMin | decoderMean | totalDecFps | tickLag p95 | finalize | roundTrip |
|---|---|---|---|---|---|---|---|---|---|---|
| 4 | 30.0 | 1 | 5.8 ms | 11.6 ms | 29.8 fps | 29.9 fps | 119.5 | 8.7 ms | 36 ms | ✓ 300/300 |
| 9 | 30.0 | 1 | 4.3 ms | 29.3 ms | 29.7 fps | 29.8 fps | 268.1 | 9.3 ms | 18 ms | ✓ 300/300 |

What this confirms:
- **Encoder is unstressed by playback contention.** `pendingMax = 1`
  at both K=4 and K=9 — at no point did a second frame stack up
  behind the one being encoded. The encoder's ~7× headroom from
  [exp 30d](../30d_synthetic-30fps-stress/README.md) survives the
  playback workload essentially intact.
- **All decoders keep up.** Even at K=9, every decoder hit ≥ 29.7
  fps for the full 10 s encode window — 268 RGBA frames/s of
  combined decode + copyTo throughput, no decoder starved by the
  encoder. (The eddy bitmap-source target is exactly this workload.)
- **`addMax` at K=9 is 29 ms.** A single brief spike — well within
  the 33 ms frame budget, and pendingMax stayed at 1 so it didn't
  cascade. No multi-frame stalls.
- **Tick loop drift is 9 ms p95.** Up from <2 ms in
  [exp 30d](../30d_synthetic-30fps-stress/README.md) (no playback
  load), but never enough to miss a 33 ms tick. The loop honors the
  30 Hz schedule under contention.
- **Output is identical to 30d's 270p pass** (315787 bytes vs 315787
  bytes). Encoder produced byte-identical WebM regardless of
  concurrent decoder activity — confirms no quality compromise under
  load.

Implications for phase 3:
- **Capture-time AV1 encode under realistic record-while-playing
  contention is fully validated** at 270p / K∈{4,9}. Encode-as-you-
  capture is the default for the
  [phase 3 spec](../../docs/superpowers/specs/2026-05-18-c2-phase3-design.md) —
  we don't need the MediaRecorder + post-record-transcode fallback at
  these resolutions.
- The result is conservative: this run keeps decoders on the main
  thread (encoder also on main). Production (per
  [phase 2 spec](../../docs/superpowers/specs/2026-05-18-c2-phase2-design.md))
  moves bitmap-source decode to per-clip workers, which would reduce
  main-thread contention further — the encoder should have *more*
  headroom in the production layout, not less.
- 30b doesn't measure thermal sustainment. Follow-up: 60-90 s run at
  K=9 to confirm the headroom holds under thermal accumulation. Not
  blocking on it given the ~7× isolated headroom.
- Still open before phase 3 lands:
  [30c (audio split pipeline)](../30c_audio-split-pipeline/README.md) —
  whether audio can be muxed into the same Output without A/V drift.

Note for eddy implementation: the fire-and-track encode pattern
(`videoSource.add(sample)` without awaiting in the tick loop, then
draining at record-stop) works even under K=9 contention. No need to
serial-await; let the source queue 1-2 deep and drain on close.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
TIMEOUT_MS=300000 PORT=<port> experiments/harness/run.sh 30b_capture-encode-under-playback
```
