# ADR-0001: No gap, no padding — closed-form frame layout

**Status:** Accepted (2026-05-14)

## Context

The frame-layout math (`src/viewport.ts`) carried a `gap` (`SIBLING_GAP
= 2`) and `rootPadding` (`ROOT_PADDING = 2`) as options. The *rendered*
paths (`canvas.tsx` `drawAt`, `media/export.ts`) already passed `0` for
both; only the *viewport-fit* paths still used the 2px defaults, so fit
math and rendering disagreed by 2px.

Because CSS gap/padding are fixed pixels, `frame(scale s)` was not
`frame(1) × s`. That non-linearity was the sole reason for the
iterative fit machinery — `findFitInsideScale`, `findClampOverflowScale`,
`MAX_FIT_ITER = 20`, and the overshoot/convergence correction.

## Decision

Frames tile edge-to-edge with no gap and no padding, in every mode and
every code path. `SIBLING_GAP`, `ROOT_PADDING`, the `options` params on
`frameRect`/`layoutFrames`, and the breadcrumb's `GAP`/`drawNode` walk
are removed.

## Consequences

- The layout is linearly scalable: `frame(scale s) === frame(1) × s`.
  Fit-scale is closed-form (`min`/`max` of axis ratios); the iterative
  fit functions and `MAX_FIT_ITER` are deleted.
- The breadcrumb minimap's container-fill (`COLOR_CONTAINER`) was only
  visible *through the gap*; with no gap, children cover it. The
  breadcrumb consumes `layoutFrames` output (leaves + selected rect)
  instead of walking the tree itself.
- Handles sit flush against frame edges (no inset). Accepted: handle
  breathing room is provided by extend/stick and zoom-to-fit, not by a
  layout inset.

## Why recorded

So future architecture reviews don't re-suggest "add gap/padding for
breathing room" — the breathing room moved to extend/stick, and the
closed-form layout depends on the insets staying zero.
