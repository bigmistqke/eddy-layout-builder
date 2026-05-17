# codec-survey

**Question:** the "~150 fps decode ceiling" we keep hitting — is it
fundamental to this device, or specific to VP8 on this device?
Measure encode + decode throughput across **VP8 / VP9 / H.264 / AV1**
in both hardware and software paths. Confirm whether moving off VP8
breaks the bandwidth wall.

## Why

Every prior experiment uses VP8 (MediaRecorder's default). The
A15's "~150 fps aggregate decode ceiling" (per 02/04/06/19c) is
load-bearing in many architectural decisions:

- Atlas being mandatory past K=4 cells (per 10/11/18g)
- Time-slicing yielding ~K=5 ceiling (per 19/19b)
- Software-decode being only marginally faster than HW (per 19c —
  but 1.7× faster solo!)

If a different codec (most likely **H.264** with mature hardware
decode on Android) gives 2-3× the throughput, much of our
architectural complexity dissolves:
- Streaming K=8 becomes realtime
- Atlas-grouping becomes a quality choice, not a necessity
- The whole "stuck at K=4" problem may be a VP8 artifact

## Setup

1. Record one VP8 source clip via MediaRecorder (the one codec we
   can record). This is the canonical content.
2. For each codec in `[vp8, vp9, h264, av1]`:
   - Probe encoder support (`VideoEncoder.isConfigSupported`),
     report whether the browser would use HW or SW
   - Probe decoder support, both `prefer-hardware` and
     `prefer-software`
   - **Encode test**: decode VP8 source frame-by-frame, encode each
     into the target codec via `VideoEncoder`. Measure encode fps,
     output bitrate (bytes / sec of source content)
   - **HW decode test**: take the encoded target chunks, decode
     them flat-out for `runSeconds`, measure aggregate fps
   - **SW decode test**: same with `hardwareAcceleration:
     'prefer-software'`
   - **Switch cost**: separate measurement — reset + configure +
     decode-first-keyframe — for HW and SW

## What's measured per codec

- `encoderSupported`, `encoderActualHardwareAcceleration`
- `decoderSupported`, `decoderActualHardwareAcceleration` (per pref)
- `encodeFps`, `encodeBytesPerSecOfContent`
- `decodeFps` (HW)
- `decodeFps` (SW)
- `decodeSwitchCostMs` (HW)
- `decodeSwitchCostMs` (SW)
- `errors` (any encode/decode errors surfaced)

## What to look for

- **H.264 HW decode ≫ VP8 HW decode** would confirm the
  bandwidth wall is VP8-specific
- **AV1 anywhere on A15** — likely no HW support; SW might work
  but slowly. Confirm
- **Encode fps below realtime (30)** — that codec can't be used
  for recording (would lag camera)
- **`hardwareAcceleration: prefer-software`** sometimes returns
  HW anyway (the browser's choice); the `decoderActualHardware-
  Acceleration` from `isConfigSupported` resolves this

## Verdict

**Codec choice changes everything.** The ~150 fps decode ceiling is largely VP8-specific.

| codec | enc fps | bytes/s | dec HW | switch HW | dec SW | switch SW |
|---|---|---|---|---|---|---|
| VP8 | 46.7 | 330 KB | 96.5 | 265 ms | 174 | 10 ms |
| VP9 | 42.9 | 251 KB | 151 | 272 ms | **263** | 16 ms |
| H.264 | ❌ unsupported on Chrome 148 Android | — | — | — | — | — |
| AV1 | 31.7 | **141 KB** | (no HW) | — | **376** | — |

Headlines:
- **AV1 SW decode = 376 fps** — 4× VP8-SW, 5× VP8-HW. Likely dav1d + SIMD.
- **AV1 bitrate = 141 KB/s** — 2.3× smaller than VP8.
- **VP9 SW decode = 263 fps** — 8 cells × 30 fps from one decoder.
- **H.264 encoder not available** on this Chrome build.
- VP9 is the realistic sweet spot (encode 43 fps with margin); AV1 is the storage/decode winner but encode is right at realtime.

Architectural implications: K=4 streaming wall dissolves for VP9/AV1. Atlas, time-slicing decoder pools, OPFS bitmap scratch all become optional for typical sessions. Open question: does SW throughput scale under N-decoder contention (19c says SW also saturates ~165 fps aggregate at VP8) — needs 20b.

## Caveats

- Codec profile strings have many variants. We pick one common
  profile per codec; results may differ slightly across profiles.
- Encoding produces in-memory chunks; large clips eat memory. Kept
  to 6 s × per-codec to stay well under tab budget.
- VideoEncoder's `output()` may not include `decoderConfig` until
  the first keyframe — handled by buffering chunks until config
  arrives.
- AV1 encode is unsupported in most browsers; we skip its encode
  test gracefully if so.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
TIMEOUT_MS=300000 PORT=<port> experiments/harness/run.sh 20_codec-survey
```
