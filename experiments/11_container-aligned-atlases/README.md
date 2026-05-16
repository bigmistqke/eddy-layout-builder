# container-aligned-atlases

**Question:** does the K=4 sub-atlas finding from 10 hold when K is
larger and sub-atlas sizes are heterogeneous — i.e. when sub-atlases
align with the *layout's leaf containers* (the actual eddy
architecture) instead of fixed quadrants?

## Why

10 found K=4 sub-atlases at CSS-pixel res give a clean recording flow:
build 1.18× contended, capture ~16% drop, playback realtime with
headroom. But 10 split a 4×4 grid into 4 equal 2×2 quadrants — a
*geometric* split, ignoring eddy's layout tree.

The real cache boundary is **per leaf container** (CONTEXT.md):
changing one cell only invalidates the container that holds it. That
means in production K = number of leaf containers, and sub-atlases are
*heterogeneous* — a container can be 1 cell or 8 cells, narrow or wide.

This experiment exercises the upper end of realistic K and checks that
heterogeneous sub-atlas sizes don't add a new cliff.

## Setup

Records once at `captureResolution`. For each `layout` in `layouts`
(below), `containers` is an array of leaf-container specs
`{ cols, rows }`. The sub-atlas geometry per container is derived to
roughly tile the viewport, matching what `frameRect` would produce.

Three layouts:
- `4-uniform` — K=4, all containers 2×2 (regression — should reproduce
  10's K=4 numbers)
- `6-mixed` — K=6, sizes mixed (1×1, 2×1, 1×2, 2×2, …) totalling ~16
  cell-units
- `8-mixed` — K=8, including several single-cell containers (which
  could equivalently be streams)

For each layout: build all sub-atlases, run baseline playback (K
decoders concurrent), run contended pass (capture + K decoders + worker
rebuilds the **largest** sub-atlas — the realistic worst-case
invalidation).

## What to look for

- **Build rate stays ~1.2× realtime under contention** — confirms the
  per-pixel build cost is K-independent and a heterogeneous mix doesn't
  add overhead beyond what's measured.
- **K decoders hold realtime** at K=6 / K=8 — likely from 06's
  hardware-decode-bound finding (smaller sub-atlases = proportionally
  cheaper per-decoder), but worth confirming.
- **The largest sub-atlas's rebuild is the worst case** — if its build
  ms × K_max-rebuilds-per-session fits comfortably in song-length, the
  flow is genuinely free.

If K=8 holds, container-aligned sub-atlases are the production
architecture: the cache invariant is "one sub-atlas per leaf
container", with no fixed K budget needed.

If K=6 holds but K=8 doesn't, we have an upper bound on layout depth
the playback engine can sustain — informs a possible "max splits"
constraint or a fallback to streaming for very deep layouts.

## Caveats

- Sub-atlases tile the source clip uniformly (same content per cell, as
  in 05/07/09/10) — optimistic vs distinct-content reality.
- The "largest sub-atlas" is the worst rebuild; a real session also
  rebuilds smaller ones, often cheaper. This measures the ceiling, not
  the average.
- Atlas resolution is CSS-pixel (matches 10's verdict).

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
PORT=<port> experiments/harness/run.sh 11_container-aligned-atlases
```
