# codec-combo-contention

**Question:** does the per-codec **solo** decode throughput from
[20](../20_codec-survey/README.md) survive under N-decoder contention?
Specifically: with a combo pool (4 HW + 4 SW), does VP9/AV1 deliver the
extrapolated aggregate (~400+ fps), or does it collapse toward a shared
ceiling like VP8 does at ~318 fps ([19d](../19d_combo-hw-sw/README.md))?

## Why

20 measured **solo** decoders per codec. 19d showed VP8 HW+SW pools
are additive. Open question: does the same additivity hold for VP9
and AV1?

Extrapolated targets if 20's solo numbers scale:
- **VP9** SW solo 263 fps × 4 + HW solo 151 fps × 4 → ~415 fps (if
  additive like VP8) or much less (if shared bottleneck per codec)
- **AV1** SW solo 376 fps × 4 → ~1500 fps SW alone (highly optimistic;
  likely saturated by memory bandwidth long before)

The honest call: SW decoders share CPU + memory bandwidth, so SW-N
won't scale linearly. The point of this experiment is to measure
where it caps for each codec, and confirm that the HW pool remains
independent of the SW pool (per-codec generalization of 19d).

## Setup

For each codec in `[vp8, vp9, av1]` (skip h264 — encoder unavailable
per 20):

1. Record VP8 source, transcode to target codec (per 20's transcode
   helper). 6 s of content.
2. Three passes per codec:
   - **hw-4** — 4 HW decoders, baseline (or skip if no HW path)
   - **sw-4** — 4 SW decoders, baseline
   - **combo-4+4** — 4 HW + 4 SW concurrent, the headline

Each pass runs `runSeconds` (10 s) flat-out. Per-decoder fps,
aggregate, drift across quarters logged.

## What's measured

Per codec × pass:
- Aggregate fps
- Per-decoder fps split by HW vs SW
- Per-decoder drift (first quarter vs last quarter — thermal)
- Errors / failed configures

## What to look for

- **VP9 combo-4+4 ≈ 400 fps** → architecture wins big; K=12+ feasible
- **VP9 combo-4+4 ≈ 200 fps** → SW pool collapses under contention;
  fewer SW decoders better
- **AV1 SW saturates quickly** (e.g. 4 × SW gives <2× solo) → AV1's
  376 fps solo is memory-bandwidth-bound, not codec-bound
- **AV1 combo-4+4** dominated by SW (no HW); meaningful absolute ceiling

## Verdict

**Per-codec SW scaling varies dramatically — codec choice matters more than expected.**

| codec | hw-4 | sw-4 | combo-4+4 | K @ 30 fps realtime |
|---|---|---|---|---|
| VP8 | 146 | 193 | **362** | 12 |
| VP9 | 174 | **93** ⚠️ | 287 | 9 |
| AV1 | n/a (no HW) | **551** 🚀 | n/a | **18** (SW pool only) |

Key surprises:
- **VP9 SW collapses under contention** — 263 fps solo (per 20) → 92 fps at N=4. Likely a single-threaded VP9 SW codepath on this device fighting for one core. Worst SW scaling of any tested codec.
- **AV1 SW scales partially** — 376 fps solo → 551 fps at N=4 (1.5×). Likely dav1d's internal threading. Single AV1-SW pool of 4 decoders = **K=18 cells at realtime** — and no HW path needed.
- **VP8 combo-4+4 = 362 fps** corroborates 19d's 318 fps; additivity confirmed across two runs.

Per-cell **cache codec** ranking on this device:
1. **AV1** — 551 fps SW pool, no atlas/combo needed for K≤18
2. **VP8** — 362 fps combo pool, needs HW+SW infrastructure
3. **VP9** — 287 fps combo, worse than VP8 despite stronger solo numbers

This reorders the codec recommendation: VP9-SW is *not* the headline; **AV1 SW pool dominates** for high-K playback on devices that have AV1 SW. The storage codec choice (VP9 for portability) stays unchanged, but the *cache* codec recommendation flips to AV1 wherever it's supported.

First scaffold attempt cascaded on AV1 combo-4+4 (no HW path → `prefer-hardware` configure failed → closed-codec errors on neighbouring SW slots). Fixed by probing HW/SW availability up front and skipping incompatible passes.

## Caveats

- 10 s runs — thermal at 60 s+ is a follow-up
- Same 1280×720 source; per-codec behavior at higher/lower res may
  differ (especially AV1 software, where decode cost is highly
  resolution-sensitive)
- `hardwareAcceleration: 'prefer-software'` is a hint; the browser
  may select HW anyway. Implicit confirmation comes from per-pool
  fps matching 20's solo numbers
- Codec profile choices match 20 exactly

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
TIMEOUT_MS=600000 PORT=<port> experiments/harness/run.sh 20b_codec-combo-contention
```
