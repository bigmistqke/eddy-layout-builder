# grid-streaming-transcoded

**Question:** same as [03_grid-streaming](../03_grid-streaming/README.md)
— does the real workload (N cells summing to one viewport) sustain
realtime? — but with **correct cell resolutions**.

## Why a separate experiment

03 recorded each cell directly from the camera, which only offers a few
discrete sensor modes — so N=9 and N=16 ran the *identical* clip and the
cross-N comparison was confounded. A real streaming pipeline must
**downscale after capture** anyway. This experiment does that
(`harness/transcode.ts`): record once, then transcode down to each
grid's true cell size.

Kept separate from 03 (rather than replacing it) so the train of thought
stays visible: 03 = naive camera-clamp attempt + why it's flawed, 04 =
the corrected version.

## Setup

Records once at `captureResolution`, then for each N in `gridSizes`
(4, 9, 16, 25) transcodes the clip to `total / √N` per axis (snapped to
16-px macroblock alignment — see below), runs N decoders looping the
transcoded clip concurrently for `runSeconds`, and reports per-decoder
sustained fps, min, aggregate, `realtimeOk` (min ≥ 28), and `transcodeMs`.

**Note on the transcode penalty:** an earlier run found re-encoded clips
decode *slower* than camera-native clips of similar size. Two fixes
landed in `harness/transcode.ts`: bitrate now scales with resolution
(a fixed bitrate over-bitrated small cells), and dimensions snap to
multiples of 16 (VP8's macroblock size — odd/unaligned dims force
padding that decodes slower). This experiment's `result.json` is the
run *after* both fixes.

## Verdict

_Pending run with the macroblock-aligned transcode._

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
PORT=<port> experiments/harness/run.sh 04_grid-streaming-transcoded
```
