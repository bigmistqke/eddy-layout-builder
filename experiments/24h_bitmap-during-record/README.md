# bitmap-during-record

**Question:** the [24e](../24e_rebuild-during-record/README.md) hot
path (capture + atlas-playback + AV1 rebuild concurrent) failed
super-linearly — capture lost 38% of frames and playback janked
22%. The all-bitmap architecture (24f / 24g) has no rebuild. **Does
bitmap render + concurrent camera capture survive, where the atlas
+ rebuild variant didn't?**

## Why

The all-bitmap path removes the load-bearing failure mode 24e
identified — there's no AV1 encode contending with playback. What's
left to validate is the surviving load: camera capture (MediaRecorder
VP8) running concurrent with K=16 cells reading from OPFS and
rendering. 24e's "capture-only" pass already showed capture +
atlas-playback is cheap (5% jank, 100% capture frames). The bitmap
equivalent should be at least that good — no codec in the render
path means even less GPU-process contention with capture.

This experiment confirms (or refutes) that prediction. If it holds,
the all-bitmap architecture is end-to-end validated on this device:
storage layer ✓ (24g), upload budget ✓ (24f), capture coexistence ✓
(this one).

## Setup

Three isolating passes at K=16, mirroring 24e's attribution shape
minus the rebuild pass:

| Pass | Bitmap render | Concurrent camera capture |
|---|---|---|
| 1 baseline | yes | no |
| 2 capture-only | no | yes (10 s) |
| 3 full | yes | yes (10 s) |

Each pass runs ~15 s. Setup phase (one-time): record VP8 source,
decode to 270p RGBA, write K=16 OPFS files (per 24g).

Pass 1 reuses 24g's render-loop shape exactly. Pass 3 adds a
fire-and-forget `recordProbeInput(captureSeconds=10)` started at
T+0. Pass 2 only runs capture, with the bitmap reader worker idle.

Comparison points:
- Pass 1 baseline ↔ 24g K=16 (should match within run-to-run variance)
- Pass 2 capture-only ↔ 24e pass 2 capture-only (capture alone is the
  same regardless of render path, so similar frame count expected)
- Pass 3 full ↔ 24e pass 4 full (the headline)
  - 24e full: 32 fps render, 22% jank, capture lost 38% of frames
  - 24h full: expected ≥ 24e capture-only quality (≥ 55 fps, < 10%
    jank, near-100% capture frames)

## What's measured

Per pass:
- Render fps + JankRecorder stats (mean / p95 / max / over33msRatio /
  streak / score)
- Long-tasks observed
- For passes 2 / 3: capture completed flag + captured chunk count
  (cf. 24e's 193 baseline vs 119 contended)
- Empty-cell ticks (per 24g — should be near zero)

## What to look for

- **Pass 1 ≈ 24g K=16** — ~59 fps, ~1.5% jank. Sanity / variance check
- **Pass 2 capture chunk count ≈ pass-3 capture chunk count** — if
  yes, capture isn't degraded by concurrent render. (Note: 24e's
  capture-only got 193 chunks; expect similar here)
- **Pass 3 ≈ pass 1 within noise** — full hot path survives cleanly,
  the all-bitmap architecture handles capture concurrency
- **Pass 3 captures fewer frames than pass 2** — capture is hurt by
  concurrent render; the bitmap path inherits some of the 24e
  problem (just less severe since no rebuild encoder)
- **Pass 3 janks worse than pass 1** — concurrent capture costs the
  bitmap render some budget. Magnitude tells us where the architecture
  sits relative to 24e's atlas-with-rebuild failure (22% jank) and
  24e's atlas-only-with-capture success (5% jank)

## Caveats

- All K=16 cells share the same source content (looped) — per 15
  cross-cell entropy isn't load-bearing for upload.
- No actual atlas rebuild here (the whole point — the architecture
  doesn't have one). The "rebuild" in eddy's bitmap design is just
  appending captured frames to the new cell's OPFS file as they
  arrive (cheap, per 18c). This experiment doesn't test that write
  path; it tests playback + capture coexistence.
- Pre-population of OPFS files happens once at setup via the main-
  thread async API (per 24g). Real eddy capture would write per-cell
  files incrementally from a writer worker (18c).
- Capture uses MediaRecorder (VP8 output) — eddy's actual encoded-
  format feed regardless of later transcode/storage decisions.
- `gl.clear` per tick (mandatory per 18c).
- Camera permission must be granted.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
TIMEOUT_MS=360000 PORT=<port> experiments/harness/run.sh 24h_bitmap-during-record
```
