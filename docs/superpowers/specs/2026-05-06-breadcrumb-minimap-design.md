# Breadcrumb Minimap Design

## Problem

The current breadcrumb in `layout-builder.tsx` uses abstract text labels (`col`, `row`, `2`) that don't communicate which region of the layout each segment refers to.

In parallel, the click-to-cycle-ancestors interaction in `node-component.tsx` (where repeated taps on a frame increment `selection.depth`) was usable when scope changes were free, but with constraint-driven canvas zoom each scope change triggers a pan/zoom animation. The user loses track of the frame between taps because the canvas keeps moving.

The breadcrumb already supports scope-up via tap (each segment sets `depth`), so the depth-cycle is a redundant shortcut that no longer pays for the confusion it causes. Removing it makes the breadcrumb the single path for scope navigation, which means the breadcrumb has to be *good* — and abstract labels aren't.

## Goals

- Remove the depth-cycle interaction from frame taps.
- Replace breadcrumb text labels with minimap thumbnails of the layout, with the in-scope region highlighted in each segment.
- Keep the change scoped to UX/rendering — no new state, no new context plumbing beyond a single canvas-aspect signal.

## Non-goals

- Changing how viewport zoom works.
- Changing how split/append modes work.
- Adding new gestures (pinch, long-press, etc.).
- Pixel-perfect minimap rendering — the minimap conveys structure, not exact proportions of nested gaps/padding.

## Behavioral changes

### Frame tap

**Before:** Tapping a frame in split mode set `selection.path` to that frame and incremented `depth` if the frame was already selected (cycling through ancestors).

**After:** Tapping a frame sets `selection.path` to that frame and `selection.depth = 0`. Tapping the same frame again is a no-op (selection is already there).

### Breadcrumb segment tap

Unchanged from current behavior: tapping a segment sets `selection.depth = seg.depth`, which triggers the existing viewport recompute and animation. The breadcrumb is now the only path for scoping up to ancestors.

### Modes

Unchanged. Split mode still shows arrow handles on the currently scoped node; append mode still shows "+" buttons. Tapping a frame is pure selection regardless of mode — only handle taps perform mode-specific operations.

## Visual design

Each breadcrumb segment renders a recursive DOM mini-tree of the entire layout, with the path-prefix at that segment's depth highlighted. Each segment shows the *full layout shape*; only the highlighted region differs across segments.

This means: tapping a segment zooms the canvas to exactly the highlighted region of that segment. The breadcrumb is a row of "tap-to-zoom-here" previews.

### Sizing

- **Height:** fixed at `~36px` (fits inside `--hud-height-notch` with padding). Tunable in CSS.
- **Width:** derived from canvas aspect — `height × (canvasW / canvasH)`.
- **Width cap:** `80px` so ultra-wide viewports don't bloat the breadcrumb.

The canvas dimensions come from a `ResizeObserver` on the canvas element. `LayoutBuilder` owns a `canvasAspect` signal (a single number, `width / height`) and passes it to `Breadcrumb` as a prop. No new context plumbing needed — `Breadcrumb` is already a child of `LayoutBuilder`.

### Highlight

- Highlighted node: `outline: 2px solid var(--color-active)` with a tinted background (`var(--color-active)` at low alpha).
- Non-highlighted nodes: faint background (e.g., `#333`), no outline.
- Containers use `display: flex` with `flex-direction` matching the container's direction (row for horizontal, column for vertical) and a small gap (`1px`).
- Cells (entities) use `flex: 1`.

This mirrors the real layout's flex behavior at thumbnail scale, so the proportions in the minimap roughly match what the user sees on the canvas. (Roughly — gaps and padding aren't faithfully reproduced.)

## Architecture

### New file: `src/breadcrumb-minimap.tsx`

Exports a single `MiniNode` component:

```tsx
export function MiniNode(props: { node: Node; highlightPath: number[] }) {
  // highlightPath.length === 0 means: this node is the highlighted one.
  // highlightPath = [-1] (or any non-matching head) means: no descendant is highlighted.
}
```

Owns its own CSS module `breadcrumb-minimap.module.css` with classes: `.miniContainer`, `.miniCell`, `.miniHighlight`, `.row`, `.col`.

### Modified: `src/layout-builder.tsx`

- The `segments` memo's shape changes: instead of `{ label, depth }`, segments produce `{ highlightPath, depth }`.
- The `<For>` over segments renders `<MiniNode node={app.layout} highlightPath={seg.highlightPath} />` instead of the text label.
- A new `canvasAspect` signal owned by `LayoutBuilder`, driven from the canvas `ResizeObserver`, passed to `Breadcrumb` as a prop.

### Modified: `src/layout-builder.module.css`

- Remove text-styling rules from `.breadcrumbContent button` (color, font-size, underline) — they're irrelevant when the button content is a minimap.
- Add layout rules for the minimap segment buttons (padding, gap, alignment).

### Modified: `src/node-component.tsx`

- Remove the depth-cycling `onClick` logic on EntityFrame.
- Replace with: `onClick = () => setSelection({ path, depth: 0 })`.

## Edge cases

### Zero-aspect at startup

Before the canvas has measured itself, `canvasAspect` returns a default (e.g., `1`). The breadcrumb will briefly render with square segments and snap to the correct aspect once the observer fires. No visual glitch worth special-casing.

### Single-entity layout (root with one child)

The minimap shows the full canvas as one cell. Segment 0 (root scope) highlights the whole minimap; segment 1 (entity scope) also highlights the same single cell. Visually identical segments — acceptable, because the canvas behavior on tap is also identical (no zoom either way at depth 0).

### Deep paths (4+ levels)

All segments at deep paths look near-identical with only a tiny moving highlight. Acceptable — most paths are 1–3 deep, and even at depth 4 the highlight usually shifts visibly between adjacent segments. If this becomes a real problem, a future change can address it (e.g., faded breadcrumb, or hybrid label+minimap).

### Wide vs tall viewports

Width capped at `80px` prevents ultra-wide segments. Tall (portrait) viewports produce narrow segments — acceptable; the height is fixed by the notch.

## What this does NOT change

- Viewport math, zoom animation, handle constraint logic.
- Mode bar, split/append handle behavior.
- The `selection` store shape.
- The frame's tap-to-pan-zoom behavior (still triggers via the existing selection-change effect).

## Testing

Manual UAT:

1. Layout with 2-deep path. Verify breadcrumb shows 3 minimap segments, each highlighting a progressively narrower region.
2. Tap a breadcrumb segment — viewport pans/zooms to that ancestor's bounds.
3. Tap a frame — viewport pans/zooms to that leaf, breadcrumb's last segment is highlighted.
4. Tap the same frame again — no animation, no scope change.
5. Resize the window — segment widths adjust to maintain canvas aspect ratio.
6. Append/split flows still work via handles on the currently-scoped frame.
