# cross-codec-dual-pool

**Question:** [19d](../19d_combo-hw-sw/README.md) showed HW and SW pools
of the **same codec** are additive. Does the additivity hold when the
two pools also use **different codecs** — specifically VP9 in HW + AV1
in SW, the strongest pair on this device per
[20b](../20b_codec-combo-contention/README.md)?

## Why

19d: VP8 HW-4 (157) + VP8 SW-4 (161) → VP8 combo-4+4 (318) within
noise. Confirmed: when two pools use disjoint physical resources, they
stack.

20b: per-codec ceilings differ wildly. On A15:
- VP9 HW-4 = 174 fps (saturated)
- VP9 SW-4 = 93 fps (SW collapses)
- AV1 SW-4 = 551 fps (best single pool on this device)

If we keep **two encoded versions** of every clip (VP9 + AV1) and
route each cell to whichever pool has headroom:
- VP9 HW pool handles ~6 cells (174 / 30)
- AV1 SW pool handles ~18 cells (551 / 30)
- **Combined: ~24 cells at realtime**, if the pools are independent

The question is whether the same independence finding from 19d holds
when the pools run different codecs. The HW pool uses the GPU video
decode unit; the SW pool uses CPU + dav1d. These should be disjoint,
but memory bandwidth could still bottleneck both.

## Setup

Same source recording → transcode to VP9 + AV1. Four passes:

- **vp9-hw-4** (baseline) — 4 VP9 HW decoders alone, expect ~174 fps
- **av1-sw-4** (baseline) — 4 AV1 SW decoders alone, expect ~551 fps
- **cross-4+4** (the headline) — 4 VP9 HW + 4 AV1 SW concurrent,
  expect ~725 fps if additive
- **cross-2+4** — 2 VP9 HW + 4 AV1 SW (asymmetric, in case 4 HW
  decoders contend with something)

Each pass runs `runSeconds` (10 s) flat-out. Per-decoder fps split by
codec/kind, aggregate, drift across quarters logged.

## What's measured

Per pass:
- Aggregate fps
- Per-pool aggregate (vp9-hw, av1-sw)
- Per-decoder fps + quarter drift (thermal)
- Errors / configure failures

## What to look for

- **cross-4+4 ≈ vp9-hw-4 + av1-sw-4 (~725 fps)** → pools independent
  across codecs; K=24 architecture is real
- **cross-4+4 ≈ av1-sw-4 alone (~550 fps)** → VP9 HW path contends
  with AV1 SW (shared memory bus, browser scheduling, etc.); two-
  codec strategy doesn't add much
- **AV1 SW drops in cross-4+4** → SW pool is sensitive to *any*
  concurrent decoder; might need to under-provision the SW side
- **VP9 HW drops in cross-4+4** → HW decoder is itself memory-
  contended

## Caveats

- Tests assume both codecs decode the *same* visual content
  (transcoded from the same VP8 source). Real sessions would have
  one encode per source, not duplicate transcodes.
- 2× storage cost per clip — the architecture is only viable if the
  combined ceiling justifies it
- AV1 encode 32 fps measured in 20 — on the edge of realtime for
  capture. The dual-encode is a finalize-step cost, not capture.
- 10 s runs; thermal at 60 s+ sustained is a follow-up
- Cross-codec routing logic (which cell uses which version) is not
  in scope — this measures whether the pools coexist

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
TIMEOUT_MS=300000 PORT=<port> experiments/harness/run.sh 20c_cross-codec-dual-pool
```
