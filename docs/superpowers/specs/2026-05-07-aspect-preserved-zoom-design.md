# Aspect-preserved zoom-to-fit

## Problem

`computeViewportTransform` currently uses `Math.max(widthFactor, heightFactor)` in `findFitToTargetScale`, which **stretches the binding axis to fill the target** and lets the other axis overflow the canvas — even when the frame could fit entirely inside the target with proportional scaling.

Concretely: a small frame (say 80 × 60 in a 1280 × 800 canvas) gets zoomed so width = target_width (1184), height becomes 888 — overflowing the canvas vertically — when it could simply fit inside the target box at width = 1184, height = 888 × ratio (smaller).

The user wants:
1. **Don't zoom** if the frame at scale=1 already has handles that fit non-overlapping (Rule 1, existing).
2. **Aspect-preserved fit-inside** as the preferred zoom (Rule 2, new): scale uniformly so the frame fits inside the target box, with one axis hitting the target exactly.
3. **Clamp-and-overflow fallback** only when Rule 2 can't grow the frame (extreme aspect ratio where one axis already exceeds target) (Rule 3, current behaviour).

## Design

### `src/constants.ts`

Add a tweakable padding constant:

```ts
// Per-side inset of the "target box" used by viewport zoom-to-fit. The
// selected frame is scaled (aspect-preserved) so it fits inside
// `canvas - 2*FRAME_PADDING` on each axis.
export const FRAME_PADDING = 2 * HANDLE_H
```

(Replaces the local `FRAME_PADDING = HANDLE_H` in viewport.ts.)

### `src/viewport.ts`

Replace `findFitToTargetScale` with a two-stage search:

```ts
function findFitInsideScale(layout, path, canvas): number
  // Iteratively scale by min(widthFactor, heightFactor).
  // Returns the scale that makes the frame fit-inside the target box,
  // or 1 if the frame already fits-inside or is too aspect-ratio-extreme.

function findClampOverflowScale(layout, path, canvas): number
  // Iteratively scale by max(widthFactor, heightFactor).
  // Returns the scale that makes the smaller-by-ratio dim fill target;
  // the other dim overflows the canvas.

function findFitScale(layout, path, canvas): number
  const inside = findFitInsideScale(...)
  if (inside > 1.001) return inside
  return findClampOverflowScale(...)
```

`computeViewportTransform` keeps its existing structure:
1. Rule 1 short-circuit (geometric handle-fit check at scale=1) stays as-is.
2. `fitScale = findFitScale(...)` replaces `findFitToTargetScale(...)`.
3. Pan-to-center stays as-is.

### Tests

Three Playwright tests covering the three rules, all using `runActions` to replay `[action]` log fragments:

1. **`no-zoom-when-not-needed.spec.ts`** (exists): single split-right → identity viewport.

2. **`handle-clears-bottom-hud.spec.ts`** (exists): four right-splits → Rule 3 (clamp-and-overflow), assert no handle pair overlaps and each handle's tip clears its overlapping HUD.

3. **`aspect-preserved-fit.spec.ts`** (new): build a small wide frame, select it, assert that after zoom:
   - frame's binding-axis dimension ≈ `canvas_dim - 2 * FRAME_PADDING` (target).
   - the other axis is **strictly less than** its target (proves no stretch).
   - aspect ratio matches the natural aspect ratio (within tolerance).

## Out of scope

- Reworking `computeExtends` / `computeSticks` — they stay as-is.
- Animation timing.
- Constants other than `FRAME_PADDING`.
