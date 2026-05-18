# backdrop-filter-cost

**Question:** how many ms/frame does the HUD's `backdrop-filter:
blur(10px) brightness(1.1) invert(0.25)` cost on the Galaxy A15?

## Why

Spec `docs/superpowers/specs/2026-05-18-mobile-css-pass-design.md` §6
keeps the backdrop-filter as-is in production but mandates an
on-device measurement to confirm it's not a meaningful jank source.
If this experiment shows > 2 ms/frame p95 contribution, the spec
already lists the mitigation options (media-query degrade on narrow
viewports) as a follow-up.

## Setup

Synthetic measurement loop, no camera, no real app. Two phases per
run:

1. Baseline: a full-viewport `<div>` painted via `requestAnimationFrame`
   with no backdrop-filter. Measure per-frame paint duration via
   `performance.now()` deltas over 300 frames (~5s).
2. With-filter: same loop, but the painted div carries the production
   backdrop-filter rule (`blur(10px) brightness(1.1) invert(0.25)`)
   over a 384×699 viewport.

Output: p50, p95, max paint delta for each phase; the difference is
the backdrop-filter cost.

## What's measured

- `baselineP50`, `baselineP95`, `baselineMax`
- `filteredP50`, `filteredP95`, `filteredMax`
- `costP50 = filteredP50 - baselineP50`
- `costP95 = filteredP95 - baselineP95`

## What to look for

- `costP95 ≤ 2 ms` — backdrop-filter is essentially free on the A15;
  the production CSS stays as-is unconditionally
- `2 ms < costP95 ≤ 5 ms` — measurable but tolerable. Document the
  number, no immediate action
- `costP95 > 5 ms` — meaningful contributor. Spec §6 mitigations
  (media-query degrade or solid-fallback on narrow viewports) become
  the recommended follow-up

## Caveats

- 300 frames is short; no thermal drift measurement
- Synthetic painted content is more compositor-friendly than the real
  app's WebGL canvas underneath; the measured cost is a lower bound
  on what production would actually pay
- Per-frame timing via `requestAnimationFrame` includes whole-frame
  cost (other browser work), not isolated paint cost — the cost
  *difference* is the meaningful number

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
TIMEOUT_MS=120000 PORT=<port> experiments/harness/run.sh 32_backdrop-filter-cost
```
