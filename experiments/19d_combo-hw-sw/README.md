# combo-hw-sw

**Question:** are hardware and software decoders **independent
bandwidth pools** on this device? If so, running both concurrently
should give ~2× the aggregate of either alone, breaking the
~165 fps ceiling we hit in 19c.

## Why

[19c](../19c_software-decoder/README.md) found:
- HW alone saturates at ~158 fps aggregate
- SW alone saturates at ~165 fps aggregate
- Both have similar ceilings but use different physical resources
  (GPU video unit vs CPU cores)

Open question: are they **additive**? If so:
- HW pool: ~158 fps
- SW pool: ~165 fps
- Combined: **~320 fps**

That'd dramatically change what's possible — K=10+ cells at realtime
without any atlas.

If instead they share an underlying bottleneck (memory bandwidth,
browser main-thread scheduling, etc.), combined aggregate ≈ either
alone, and combo offers nothing.

## Setup

Same source clip, same flat-out decode shape as 19c. Five passes:

- **hw-4** (baseline) — 4 HW decoders, expected ~158 fps
- **sw-4** (baseline) — 4 SW decoders, expected ~165 fps
- **combo-2+2** — 2 HW + 2 SW concurrent
- **combo-4+4** — 4 HW + 4 SW concurrent (the headline)
- **combo-2+4** — 2 HW + 4 SW (asymmetric)

Each pass runs `runSeconds` (10 s) flat-out. Per-decoder fps and
aggregate logged + drift across run quarters for thermal.

## What's measured

Per pass:
- Aggregate fps (sum across all decoders)
- Per-decoder fps split by HW vs SW
- Per-decoder drift (first quarter vs last quarter — surfaces
  thermal throttle)
- Switch cost on each path

## What to look for

- **combo-4+4 ≈ 320 fps** → pools are independent, 2× bandwidth
  available. Headline result.
- **combo-4+4 ≈ 165 fps** → shared underlying bottleneck. Combo
  doesn't help.
- **HW decoders throttle, SW stays flat** under combo → independent
  but HW throttles faster
- **SW decoders slow when HW is also running** → memory bandwidth
  contention

## Verdict

**HW and SW pools are fully independent — additive within noise.**

| pass | aggregate fps | hw | sw |
|---|---|---|---|
| hw-4 | 156.6 | 156.6 | — |
| sw-4 | 161.2 | — | 161.2 |
| **combo-4+4** | **317.7** | 161.6 | 156.1 |
| combo-2+2 | 238.7 | 90.2 | 148.5 |
| combo-2+4 | 242.2 | 86.6 | 155.6 |

combo-4+4 ≈ hw-alone + sw-alone (157 + 161 = 318) — no shared bottleneck on this device for VP8. Per-decoder thermal drift small (HW drifts ~10% across the 10s run; SW flat).

Implications:
- K=10 cells × 30 fps becomes realtime on VP8 without atlas / time-slicing
- Two-pool architecture is genuinely additive — worth the implementation cost
- Combined with [20](../20_codec-survey/README.md)'s VP9-SW 263fps, a VP9 combo pool could plausibly hit ~400 fps aggregate

## Caveats

- VP8 only (per 20's codec survey, other codecs may behave
  differently)
- 10 s runs — thermal at 60 s+ sustained is a follow-up
- `hardwareAcceleration: 'prefer-software'` is a hint; the browser
  may select HW anyway. 19c gave strong implicit evidence SW path
  was used (different fps + switch cost); same applies here.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
TIMEOUT_MS=300000 PORT=<port> experiments/harness/run.sh 19d_combo-hw-sw
```
