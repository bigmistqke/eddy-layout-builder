# build-cost

**Question:** how does atlas build time scale with clip length — and is
the build-rate constant enough to plan a chunked/pipelined rebuild
around?

## Why

05/07 measured ~10–15 s to composite a **6-second** clip. The build is
per-frame work (decode → draw → re-encode every frame), so it should
scale linearly — meaning a 3–5 min song's composite takes **~6–10 min**
to build. That inverts the hybrid's "build ≪ take" assumption.

The single number that matters is the **slope**: build-seconds per
second-of-content. If it's a flat ~2× across clip lengths, the rebuild
cost is fully predictable and a chunked/pipelined strategy can be sized
against it. If it's super-linear, even chunking won't save it.

## Setup

Records clips of several lengths (`durations` — 3, 6, 9 s), composites
each into the same fixed-N atlas (N=16; atlas frame size is constant so
N shouldn't matter), and reports `compositeMs` and `buildRateVsRealtime`
(build-seconds ÷ content-seconds) for each.

> **Finding before the sweep even ran:** a first attempt with a 16 s
> clip **OOM-crashed Chrome** during the composite. Single-pass
> compositing has a memory ceiling well under a full song — so chunking
> isn't just for pipelining, it's *mandatory*. Durations kept to lengths
> that complete.

(Required bumping `harness/input.ts`'s `MAX_CHUNKS` 150 → 600 so longer
clips aren't truncated.)

**Read it as:** a flat `buildRateVsRealtime` across durations → linear,
slope pinned, chunking is plannable. Rising ratio → super-linear, worse
than feared.

## Verdict (2026-05-14 · Galaxy A15 · Android 10 · Chrome 148)

Build cost is **~1.2× realtime and ~linear** — much better than the ~2×
extrapolated from 05 (whose "6 s clip" actually hit the old
`MAX_CHUNKS=150` cap, so it was ~10 s of content — inflating the ratio).

| clip | frames | build | rate |
|---|---|---|---|
| 3 s | 44 | 3.5 s | 1.15× realtime |
| 6 s | 84 | 7.1 s | 1.19× realtime |
| 9 s | 127 | 11.1 s | 1.23× realtime |

- **Slope ≈ 1.2× realtime**, slight upward drift (1.15 → 1.23) — mild
  super-linearity, likely thermal / memory creep over the run.
- The camera records at **~14 fps** (44 frames / 3 s), not 30 — fewer
  frames to decode and build than assumed.
- **Hard memory ceiling:** a first attempt at 16 s OOM-crashed Chrome
  during the composite. Single-pass compositing cannot span a full song
  — **chunking is mandatory for memory**, independent of the
  pipelining argument.

### Implication for the hybrid

A 5-min song's composite builds in ~6 min (1.2× realtime) — tight but
workable: it outpaces a take by only 20%, so any think-time between
takes keeps the streamed-over count bounded. But the build **must** be
chunked into ≤~9 s segments (memory ceiling), which also makes it
naturally pipelineable — play / stream-over the early chunks while later
ones build.

**Next:** `09` — chunked + pipelined rebuild, and the still-unmeasured
`composite-decode + K concurrent cell-streams` (the steady-state hybrid
load).

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
PORT=<port> experiments/harness/run.sh 08_build-cost
```
