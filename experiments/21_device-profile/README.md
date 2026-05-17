# device-profile

**Question:** what's the minimal probe that an eddy runtime can run
once on a fresh device to pick its codec strategy and budget? Output
a portable JSON **device profile** the rest of the app consumes.

## Why

[20](../20_codec-survey/README.md) + [19d](../19d_combo-hw-sw/README.md)
showed codec performance and HW/SW pool independence are highly
device-specific. A15 numbers don't transfer to other devices. We
need:

1. A probe that runs in **a few seconds** on first launch (or after
   a Chrome major version bump), not the ~60 s of experiment 20.
2. A stable JSON shape the rest of `src/` can read without re-running
   the probe every session.
3. An invariant that gives **portable storage** (canonical codec for
   collaboration) **plus** **device-optimal playback** (cache codec
   for speed).

This is the formal artifact behind the codec strategy. Architecturally:
the profile is sticky per device-Chrome pair, the canonical storage
codec is universal, and the cache codec is whatever the profile
recommends.

## Setup

Three phases, all short:

### Phase 1 — encoder availability (~1 s)

For each of `[vp9, av1, h264, vp8]`, call
`VideoEncoder.isConfigSupported` at 1280×720, 30 fps. Records:
- `supported`
- `actualHardwareAcceleration` ("prefer-hardware" or
  "prefer-software" as the browser would actually choose)
- No actual encoding — config probe only.

### Phase 2 — decode throughput, short (~1 s per codec)

For each codec where decode is supported (`prefer-hardware` and/or
`prefer-software`):
- Transcode 1 s of recorded VP8 content into target codec (or skip
  for codecs whose encoder is unsupported — use canonical VP8 chunks
  if so)
- Run a 1-second flat-out decode with **one** decoder per kind
- Records `decodeFps` per kind

Skipped if (a) encoder unsupported for that codec AND (b) we don't
have a known-good test asset in that codec.

### Phase 3 — combo headroom (~2 s)

For the **best** codec from phase 2 (highest combined HW+SW solo
fps), run a 2-second combo-2+2 pass. Records `comboAggregateFps`.
Multiplied to estimate combo-4+4 headroom (matching 19d/20b's
geometry without paying the full 10 s cost).

Total target: **~6 s** including a 1 s VP8 recording from the
camera at the top.

## Output schema

```json
{
  "device": { "userAgent": "...", "viewport": {...} },
  "encoders": {
    "vp8":  { "supported": true, "hwAcceleration": "..." },
    "vp9":  { "supported": true, "hwAcceleration": "..." },
    "av1":  { "supported": false },
    "h264": { "supported": false }
  },
  "decoders": {
    "vp9": {
      "hw": { "supported": true, "decodeFps": 150 },
      "sw": { "supported": true, "decodeFps": 260 }
    },
    "av1": {
      "hw": { "supported": false },
      "sw": { "supported": true, "decodeFps": 370 }
    }
  },
  "recommendation": {
    "captureCodec":  "vp9",
    "storageCodec":  "vp9",
    "cacheCodec":    "av1",
    "estimatedComboAggregateFps": 410,
    "estimatedMaxCells": 13
  }
}
```

## Recommendation rules

- `captureCodec` = encoder with `encodeFps ≥ 30` AND best decoder
  throughput. Default `vp9` if supported, else `vp8`.
- `storageCodec` = the **portable** codec — currently fixed to `vp9`
  (broadest mature support). Profile records the recommendation;
  fleet-wide it should rarely change.
- `cacheCodec` = the codec with highest `decodeFps` (HW or SW) on
  *this* device. May equal `storageCodec` (then no cache needed).
- `estimatedComboAggregateFps` = phase 3 combo-2+2 × 2 (rough; 20b
  will tell us the constant)
- `estimatedMaxCells` = `floor(estimatedComboAggregateFps / 30)`

## What to look for

- **Probe completes in ≤ 10 s on A15** — usability bar
- **Recommendation matches 20's verdict** for this device (vp9
  capture, av1 cache, ~12 cell ceiling)
- **JSON shape stable across browsers** — same fields populated or
  set to `supported: false`
- **No state mutation** — probe is pure, idempotent, safe to re-run

## Caveats

- Encoder probe is configuration-only, not actual encode. Some
  configs report supported but fail at runtime — accept this gap.
- Single-codec, single-resolution. Real recommendation surface is
  larger (e.g. 4K, 1080p) but YAGNI for v1.
- Phase 3 doubles a 2-decoder result to estimate 4-decoder; 20b
  validates whether the relationship is linear at this device.
- The probe assumes a working camera/mic — same precondition as
  the rest of the harness.
- Profile cache invalidation strategy is out of scope here; this
  experiment defines the shape and timing only.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
TIMEOUT_MS=120000 PORT=<port> experiments/harness/run.sh 21_device-profile
```
