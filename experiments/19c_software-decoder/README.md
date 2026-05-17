# software-decoder

**Question:** does forcing `hardwareAcceleration: 'prefer-software'`
sidestep the GPU decode-unit bottleneck (per 02/06: ~150 fps aggregate
on the A15 regardless of decoder count)? Does it scale with CPU cores
or thermal-throttle into uselessness?

## Why

Every prior experiment uses hardware-accelerated WebCodecs decoders
by default, which share the GPU's video decode unit:

- 1 HW decoder solo (per 01): ~85 fps @ 720p
- 4 HW decoders concurrent (per 02/04): ~150 fps aggregate
- Past N=4, aggregate saturates — no per-decoder gain

Software decoders run on CPU, *not* the GPU video unit. So in
principle they:
- Don't compete with hardware-decoded streams
- Scale with CPU cores (A15 has 8 cores)
- Could be *additive* on top of the hardware budget

But software decode at HD resolution on a low-end phone could be:
- Much slower per-decoder (5 fps/core instead of 30)
- Thermally aggressive (CPU at full tilt sustains poorly)
- Lose the zero-copy WebGL upload path (per Descript's research) —
  each frame costs an extra texImage2D copy

We have no data either way. This is a focused spike to find out.

## Setup

Five passes, each ~10 s flat-out decode (long enough to surface
thermal drift):

1. **hw-solo** — 1 HW decoder, baseline (should match 01: ~85 fps)
2. **sw-solo** — 1 SW decoder, throughput at the same load
3. **hw-4** — 4 HW decoders concurrent (should match 02/04: ~150 fps agg)
4. **sw-4** — 4 SW decoders concurrent
5. **sw-8** — 8 SW decoders concurrent (push CPU scaling)

Per pass: each decoder loops the source clip flat-out, output handler
counts + closes frames. Report total decoded frames, aggregate fps,
per-decoder fps, and switch cost (separate measurement: reset +
configure + first-keyframe decode time).

## What to look for

- **sw-solo fps vs hw-solo fps** — within 2× either way is acceptable;
  way slower (e.g. 5 fps) means software path isn't viable
- **sw-4 vs hw-4** aggregate — does software scale better with N?
- **sw-8 vs hw-4** — the headline. If sw-8 > hw-4, software is a
  real additional bandwidth source
- **per-decoder fps stays stable** across pass durations → no
  thermal throttle
- **per-decoder fps drops over time** → thermal throttle; software
  doesn't help long-term
- **`hardwareAcceleration: 'prefer-software'` is a *hint*** — the
  browser may still pick hardware. We can't directly check what was
  used, but dramatically different numbers between hw-N and sw-N are
  the implicit signal.

## Caveats

- VP8 specifically. Other codecs (H.264, VP9, AV1) may behave
  differently. Probably worth a follow-up sweep.
- All decoders use the same source clip — content variability
  doesn't factor in.
- We don't measure CPU contention against capture / render — those
  aren't running in this experiment. Adding them is a follow-up.
- No frame upload step here; we just decode + close. Upload cost
  difference (zero-copy vs copy) is a separate question.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
TIMEOUT_MS=300000 PORT=<port> experiments/harness/run.sh 19c_software-decoder
```
