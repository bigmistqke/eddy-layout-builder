# capture-encode-decoders-in-workers

**Question:** with the K playback decoders moved off the main thread
(into per-clip web workers, matching the
[phase 2 production layout](../../docs/superpowers/specs/2026-05-18-c2-phase2-design.md)),
can the main-thread AV1 encoder sustain 30 fps at **720p** during
record-while-K=9-playing?

## Why

[Exp 30b](../30b_capture-encode-under-playback/README.md) found that
at 720p with K=9 decoders all running on the main thread, the encoder
fell to 190 ms p95 add latency, tickLag drifted to 147 ms, and decoders
cratered to 13.2 fps. Useful as a worst-case baseline — but production
won't share that layout. Per
[phase 2 spec](../../docs/superpowers/specs/2026-05-18-c2-phase2-design.md),
each clip's decoder + RGBA cache runs in its own web worker.

So the actual production question is: with K=9 decoders in workers
and the encoder owning the main thread alone, can 720p sustain?

This experiment isolates that.

## Setup

Same fixture as 30b: 6 s of synthetic-pattern 720p AV1 WebM, demuxed
to `EncodedVideoChunk[]` + `VideoDecoderConfig`.

Per K in {4, 9}:

1. Spawn K **web workers**, each running a looping decoder + RGBA
   copy. Init each worker with `{chunks, config}` (transferred via
   structured clone). Worker decodes the chunk loop at 30 fps,
   `frame.copyTo({format:'RGBA'})` into a per-worker buffer, closes
   the frame, repeats. Periodically posts `{framesDecoded}` heartbeat
   so the main thread can count progress.
2. Warm up 1 s.
3. On the main thread, run the same synthetic-30fps encoder as
   [exp 30d](../30d_synthetic-30fps-stress/README.md): paint frame →
   wrap as `VideoSample` → `videoSource.add(sample)` (fire-and-track).
4. After 10 s of encode, request final `framesDecoded` from each
   worker, terminate workers, finalize encoder.

Encode + fixture at 1280×720, 30 fps, AV1.

## What's measured

For the encoder (same as 30b):
- `encodedFps`, `pendingAddsMax`, `addP95Ms`, `addMaxMs`,
  `tickLagP95Ms`, `finalizeMs`, `webmBytes`, `roundTripVerified`

For each worker decoder:
- `decoderFps[i]` — frames decoded ÷ encode window
- `decoderFpsMin` / `decoderFpsMean` / `totalDecoderFps`

The expected comparison vs [30b 720p](../30b_capture-encode-under-playback/README.md):

| | main-thread (30b) | workers (30f, expected) |
|---|---|---|
| encoder add p95 | 190 ms (bad) | should drop substantially |
| encoder tickLag p95 | 147 ms (bad) | should drop substantially |
| finalize | 8.6 s (bad) | should drop substantially |
| decoder fps | 13.2 (bad) | per-worker should rise |

## What to look for

- **K=9, encoder add p95 ≤ 33 ms, decoderMin ≥ 25 fps** — workers
  cleanly enable 720p record-while-playing; phase 3 can pursue
  canonical-at-camera-native
- **K=9, encoder add p95 still > 33 ms** — even off-main-thread
  decode load is enough to keep the encoder out of realtime at 720p
  on this device; 720p canonical is off the table regardless of
  threading
- **decoders drop below ~25 fps but encoder is fine** — workers are
  CPU-throttled by Android's cgroup limits; production playback
  quality would degrade during record
- **finalize jumps to multi-second** — encoder is queueing rather
  than encoding realtime; the "encodedFps=30" surface number is
  misleading (same trap as 30b 720p)

## Caveats

- Worker startup is included in `warmupMs`; not measured separately
- Each worker gets a structured-clone copy of the chunk fixture.
  ~180 chunks × small AV1 packets is modest; transfer time is amortized
  during warmup
- Worker count = K; one worker per clip. Production may share workers
  across clips eventually, but 30b's per-clip pattern matches phase 2
- Audio out of scope (see
  [30c](../30c_audio-split-pipeline/README.md))
- 10 s; no thermal sustainment measurement

## Findings (2026-05-18, sha `16351d2`, Galaxy A15)

Workers help on two of three axes but **don't make 720p record-while-
playing realtime**. The encoder still falls behind the frame budget at
K=9; moving decoders off-thread can't compensate for CPU-bandwidth
contention between encoder and decoders sharing the same SoC cores.

| Metric | main-thread (30b) | workers (30f) | Δ |
|---|---|---|---|
| K=4 add p95 | 74.7 ms | **83.9 ms** | ↑ (worse) |
| K=4 tickLag p95 | 71.6 ms | **3.2 ms** | ↓ much better |
| K=4 decoderMin | 26.9 fps | **30.0 fps** | ↑ better |
| K=4 finalize | 5.1 s | 3.8 s | ↓ better |
| K=9 add p95 | 190.1 ms | **315.5 ms** | ↑ worse |
| K=9 tickLag p95 | 146.6 ms | **9.1 ms** | ↓ much better |
| K=9 decoderMin | 13.2 fps | **17.6 fps** | ↑ better |
| K=9 finalize | 8.6 s | 7.5 s | ↓ better |

What workers fix:
- **Tick loop honors 30 Hz schedule.** With decoders on main thread,
  the encode-tick loop was missing every other frame's wakeup
  (`tickLagP95 = 147 ms` at K=9). With workers, the loop is unblocked
  (`tickLagP95 = 9 ms`).
- **Decoders themselves run faster.** K=4 decoders hit 30 fps cleanly
  (vs 27 on main); K=9 decoders rose from 13 to ~18-22 fps. Not yet
  realtime at K=9, but playback would be much less janky.

What workers don't fix:
- **Encoder is still not realtime at 720p.** `addP95` actually got
  *worse* — 84 ms at K=4 and 315 ms at K=9. The encoder runs on the
  main thread; while it's no longer blocked by main-thread decode
  work, it now competes with K background-thread AV1 decoders for the
  same physical CPU cores. Galaxy A15 has 8 cores; with K=9 worker
  threads each running AV1 decode, the encoder can't get
  uninterrupted core time.
- **Finalize still multi-second.** The encoder's per-frame deficit
  accumulates in the source's internal queue, then drains on
  `finalize()` (3.8-7.5 s).

Why workers *hurt* the encoder:
- Decoders on main thread implicitly take turns with the encoder on
  the same core — the encoder gets a fair share.
- Decoders in workers run in parallel on other cores, all the time —
  they consume more total CPU bandwidth than the serialized version,
  saturating the SoC's memory subsystem and core schedulers. The
  encoder's single core is now sharing thermal + memory bandwidth
  with K others that are continuously busy, vs intermittently busy.

This is a real device-constrained finding, not an implementation
issue.

Implications for phase 3:
- **Canonical-at-camera-native (720p) for record-while-K=9-playing is
  off the table on this hardware**, regardless of threading
  architecture. The bottleneck is CPU + memory bandwidth, not
  main-thread scheduling.
- **270p remains the realistic canonical-encode ceiling.** At 270p
  the encoder uses ~10% of a core (see
  [exp 30d](../30d_synthetic-30fps-stress/README.md)), so even under
  worker contention it should remain realtime. Worth re-running this
  experiment at 270p to confirm workers don't introduce a regression
  there.
- **If 720p canonical is required for product reasons** (fullscreen
  preview, export quality), the options are:
  1. Pause/throttle K-cell playback during record (breaks the visual-
     loop UX that's core to eddy)
  2. Capture at native, store at native, but only re-derive cell
     RGBA mips at 270p — and only allow record while K ≤ ~4
  3. Skip the synchronous-encode path and use post-record-transcode
     instead, where the encode can run after K-cell playback drops
     idle on record-stop
- Worth re-checking when AV1 hardware encode arrives on later Android
  devices — this finding is specific to AV1 SW encode contending with
  AV1 SW decode on a budget SoC.

Note for eddy implementation: when picking the worker pool size for
phase 2 production, remember that more workers ≠ better encoder
throughput — they compete for the same cores. K=9 decoders + 1
encoder is already at the edge on this device; doing anything else on
the SoC (audio capture, UI animation) during record needs to be
explicitly cheap.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
TIMEOUT_MS=300000 PORT=<port> experiments/harness/run.sh 30f_capture-encode-decoders-in-workers
```
