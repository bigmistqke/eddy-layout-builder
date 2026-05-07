import { FRAME_PADDING, HANDLE_H, HANDLE_W, ROOT_PADDING, SIBLING_GAP } from "./constants"
import type { Direction, Node, Selection } from "./types"

/**
 * `scale` is the *size multiplier* applied to the canvas by setting
 * `width = canvasW * scale; height = canvasH * scale` on the layout root —
 * NOT a CSS `transform: scale()`. We expand the layout to its real pixel
 * dimensions so flex children grow at native resolution; text and SVG stay
 * crisp. Handles (with fixed CSS sizes) automatically stay at viewport size
 * because they are not scaled by anything — there is no inverse-scale needed.
 *
 * `x`/`y` are the translation applied to the (now-larger) layout root so the
 * selected node lands at the canvas viewport center.
 */
export type ViewportTransform = { scale: number; x: number; y: number }

export const IDENTITY_VIEWPORT: ViewportTransform = { scale: 1, x: 0, y: 0 }

/** Path key for the selected node — entity path minus `depth` levels. */
export function selectedPathKey(selection: Selection): string {
  const len = selection.path.length - selection.depth
  if (len <= 0) {
    return ""
  }
  return selection.path.slice(0, len).join(".")
}

/**
 * Compute the viewport transform for a selected frame's base rect.
 *
 * `minScale`: minimum scale to apply regardless of handle-fit needs. When
 * already zoomed, callers pass `currentScale` here so the viewport never
 * zooms *out* on tap; only the back button does that.
 *
 * `hudRects`: actual HUD rectangles in canvas-relative coords (so a corner
 * HUD doesn't get treated as spanning the whole edge). Used for natural-fit
 * decision: if the frame's handles overlap any HUD enough that extend-
 * induced same-axis-pair overlap occurs, pan to canvas center. Otherwise
 * identity — preserves "no pan when not needed" UX.
 */
/** Two-stage zoom search:
 *
 *  Rule 2 — `findFitInsideScale` iterates by `min(widthFactor, heightFactor)`
 *  so the frame fits ENTIRELY inside the target box (canvas inset by
 *  FRAME_PADDING per side). The binding axis hits target exactly; the
 *  other axis is smaller. Aspect ratio preserved.
 *
 *  Rule 3 — `findClampOverflowScale` iterates by `max(...)`. Used only
 *  when fit-inside can't grow the frame (extreme aspect ratios where
 *  one axis already exceeds target while the other is far smaller).
 *  The smaller-by-ratio dim fills target; the larger overflows the
 *  canvas. Stick + extend keep the off-canvas handles visible.
 *
 *  Iterative in both cases because CSS padding/gap are fixed pixels —
 *  rect dims at scale s are NOT (rect at 1) × s. Converges in 1–3
 *  iterations typically, capped to avoid runaway. */
// MAX_FIT_ITER alone bounds the loop — there's no need for a separate
// scale cap. The dim-positivity check (rect.w/h <= 0 doubles scale and
// continues) ensures we never compute factors against zero/negative
// dims, so factor is always finite.
const MAX_FIT_ITER = 20
function findFitInsideScale(
  layout: Node,
  path: number[],
  canvas: { width: number; height: number },
): number {
  const targetWidth = canvas.width - 2 * FRAME_PADDING
  const targetHeight = canvas.height - 2 * FRAME_PADDING
  if (targetWidth <= 0 || targetHeight <= 0) {
    return 1
  }
  let scale = 1
  for (let iteration = 0; iteration < MAX_FIT_ITER; iteration++) {
    const rect = frameRect(layout, path, {
      width: canvas.width * scale,
      height: canvas.height * scale,
    })
    if (rect.width <= 0 || rect.height <= 0) {
      scale *= 2
      continue
    }
    const widthFactor = targetWidth / rect.width
    const heightFactor = targetHeight / rect.height
    const factor = Math.min(widthFactor, heightFactor)
    // Converged: binding axis is at target. Use abs(factor-1) — NOT
    // factor<=1.001 — because flex-math non-linearity can overshoot at
    // high scale, putting both axes past target. We must allow shrink
    // back down to land the binding axis exactly on target.
    if (Math.abs(factor - 1) < 0.001) {
      return scale
    }
    scale *= factor
  }
  return scale
}

function findClampOverflowScale(
  layout: Node,
  path: number[],
  canvas: { width: number; height: number },
): number {
  const targetWidth = canvas.width - 2 * FRAME_PADDING
  const targetHeight = canvas.height - 2 * FRAME_PADDING
  if (targetWidth <= 0 || targetHeight <= 0) {
    return 1
  }
  let scale = 1
  for (let iteration = 0; iteration < MAX_FIT_ITER; iteration++) {
    const rect = frameRect(layout, path, {
      width: canvas.width * scale,
      height: canvas.height * scale,
    })
    if (rect.width <= 0 || rect.height <= 0) {
      scale *= 2
      continue
    }
    const widthFactor = targetWidth / rect.width
    const heightFactor = targetHeight / rect.height
    const factor = Math.max(widthFactor, heightFactor)
    // Same overshoot fix as findFitInsideScale: flex-math non-linearity
    // at high scale can leave both axes past target — factor < 1 here
    // means we should shrink back so the smaller-by-ratio axis lands
    // exactly on target.
    if (Math.abs(factor - 1) < 0.001) {
      return scale
    }
    scale *= factor
  }
  return scale
}

/** Minimum dimension required for both same-axis and cross-pair handle
 *  pairs to fit non-overlapping on a single axis. Cross-pair geometry
 *  (a top handle's HANDLE_W center span vs a rotated left/right
 *  handle's HANDLE_H span) is the binding constraint. */
const MIN_HANDLE_DIM = HANDLE_W + 2 * HANDLE_H

function findFitScale(
  layout: Node,
  path: number[],
  canvas: { width: number; height: number },
): number {
  const inside = findFitInsideScale(layout, path, canvas)
  if (inside > 1.001) {
    // Rule 2 zoom is fine ONLY if both axes still have room for the
    // four handles to lay out non-overlapping. With extreme aspect
    // ratios, fit-inside lands the non-binding axis below MIN_HANDLE_DIM
    // — left and right handles end up centered on top of each other.
    // In that case fall through to clamp-overflow (Rule 3) which makes
    // the smaller-by-ratio axis fill target and lets the other overflow.
    const rect = frameRect(layout, path, {
      width: canvas.width * inside,
      height: canvas.height * inside,
    })
    if (Math.min(rect.width, rect.height) >= MIN_HANDLE_DIM) {
      return inside
    }
  }
  return findClampOverflowScale(layout, path, canvas)
}

export function computeViewportTransform(
  layout: Node,
  path: number[],
  canvas: { width: number; height: number },
  minScale = 1,
  hudRects: Rect[] = [],
): ViewportTransform {
  // Base rect at scale=1 — used for the natural-fit short-circuit only.
  // CSS `padding` and `gap` are *fixed pixels*, so the rect at scale s
  // is NOT baseRect × s; we recompute via flex math at the scaled
  // canvasInner size for both handle-fit decisions and centering.
  const baseRect = frameRect(layout, path, canvas)
  if (baseRect.width === 0 || baseRect.height === 0) {
    return IDENTITY_VIEWPORT
  }

  // Natural-fit short-circuit: at scale=1, do all 4 handles fit
  // non-overlapping (after the natural extends pushed by HUDs)? If yes,
  // don't zoom at all — preserves "no zoom when not needed" UX. The four
  // checks mirror the geometry of the rendered handles:
  //   * vertical-pair non-overlap: frame.height ≥ 2·HANDLE_H + ext.top + ext.bottom
  //   * horizontal-pair non-overlap: frame.width ≥ 2·HANDLE_H + ext.left + ext.right
  //   * cross-pair non-overlap (top ↔ left/right): frame.width ≥ HANDLE_W + 2·HANDLE_H
  //   * cross-pair non-overlap on vertical: frame.height ≥ HANDLE_W + 2·HANDLE_H
  const naturalExt = computeExtends(baseRect, hudRects)
  const sameAxisH = 2 * HANDLE_H
  const crossPair = HANDLE_W + 2 * HANDLE_H
  const verticalFits = baseRect.height >= sameAxisH + naturalExt.top + naturalExt.bottom
  const horizontalFits = baseRect.width >= sameAxisH + naturalExt.left + naturalExt.right
  const crossWidthFits = baseRect.width >= crossPair
  const crossHeightFits = baseRect.height >= crossPair
  if (verticalFits && horizontalFits && crossWidthFits && crossHeightFits) {
    return IDENTITY_VIEWPORT
  }

  const fitScale = findFitScale(layout, path, canvas)
  const scale = Math.max(fitScale, minScale)

  // Pan to canvas center using REAL flex-math at the scaled canvasInner.
  const realRect = frameRect(layout, path, {
    width: canvas.width * scale,
    height: canvas.height * scale,
  })
  const x = canvas.width / 2 - (realRect.x + realRect.width / 2)
  const y = canvas.height / 2 - (realRect.y + realRect.height / 2)
  return { scale, x, y }
}

/** CSS translate string for `transform`. Caller applies the size multiplier
 *  separately via `width`/`height`. */
export function transformToCss(t: ViewportTransform) {
  return `translate(${t.x}px, ${t.y}px)`
}

/** Axis-aligned rect in canvas-local coordinates. Coordinates are in CSS
 *  pixels of the un-zoomed canvas. */
export type Rect = { x: number; y: number; width: number; height: number }

/**
 * Compute a frame's rect from the layout tree and canvas dimensions.
 *
 * Mirrors the CSS flex layout: every container has `display: flex` with
 * children at `flex: 1`. The root container has padding on all sides plus
 * gap between children; non-root containers have only gap.
 *
 * Pure function — no DOM reads. Caller passes canvas dims and the path of
 * the target frame (empty path = root container).
 */
export function frameRect(
  layout: Node,
  path: number[],
  canvas: { width: number; height: number },
): Rect {
  let rect: Rect = {
    x: ROOT_PADDING,
    y: ROOT_PADDING,
    width: canvas.width - 2 * ROOT_PADDING,
    height: canvas.height - 2 * ROOT_PADDING,
  }
  let current: Node = layout
  for (const childIndex of path) {
    if (current.type !== "container") {
      break
    }
    const childCount = current.children.length
    const totalGap = SIBLING_GAP * (childCount - 1)
    if (current.direction === "horizontal") {
      const childWidth = (rect.width - totalGap) / childCount
      rect = {
        x: rect.x + childIndex * (childWidth + SIBLING_GAP),
        y: rect.y,
        width: childWidth,
        height: rect.height,
      }
    } else {
      const childHeight = (rect.height - totalGap) / childCount
      rect = {
        x: rect.x,
        y: rect.y + childIndex * (childHeight + SIBLING_GAP),
        width: rect.width,
        height: childHeight,
      }
    }
    current = current.children[childIndex]
  }
  return rect
}

/** Apply scale + translation to a rect. The scale multiplies width/height
 *  and offsets x/y; the translation is added on top in canvas coords. */
export function applyTransform(
  rect: Rect,
  scale: number,
  translation: { x: number; y: number },
): Rect {
  return {
    x: rect.x * scale + translation.x,
    y: rect.y * scale + translation.y,
    width: rect.width * scale,
    height: rect.height * scale,
  }
}

/** Compute each handle's natural rect (in canvas-relative coords) given
 *  the frame's rect. Mirrors the CSS positioning of ArrowNotch:
 *  top/bottom centered horizontally on the respective edge; left/right
 *  rotated 90° so dimensions swap. */
export function handleRects(frame: Rect): Record<Direction, Rect> {
  const centerX = frame.x + frame.width / 2
  const centerY = frame.y + frame.height / 2
  return {
    top: { x: centerX - HANDLE_W / 2, y: frame.y, width: HANDLE_W, height: HANDLE_H },
    bottom: {
      x: centerX - HANDLE_W / 2,
      y: frame.y + frame.height - HANDLE_H,
      width: HANDLE_W,
      height: HANDLE_H,
    },
    left: { x: frame.x, y: centerY - HANDLE_W / 2, width: HANDLE_H, height: HANDLE_W },
    right: {
      x: frame.x + frame.width - HANDLE_H,
      y: centerY - HANDLE_W / 2,
      width: HANDLE_H,
      height: HANDLE_W,
    },
  }
}

function rectsOverlap(first: Rect, second: Rect): boolean {
  return (
    first.x < second.x + second.width &&
    second.x < first.x + first.width &&
    first.y < second.y + second.height &&
    second.y < first.y + first.height
  )
}

/** Per-direction extend amount (px) for a frame's handle notches against
 *  HUDs. For each handle, finds the maximum overlap with any HUD on that
 *  handle's outward side; that distance is how far the notch needs to
 *  grow to push its visible portion past the HUD. */
export function computeExtends(frame: Rect, hudRects: Rect[]): Record<Direction, number> {
  const handles = handleRects(frame)
  const extend: Record<Direction, number> = { top: 0, bottom: 0, left: 0, right: 0 }
  for (const hud of hudRects) {
    for (const direction of ["top", "bottom", "left", "right"] as Direction[]) {
      const handle = handles[direction]
      if (!rectsOverlap(handle, hud)) {
        continue
      }
      let amount = 0
      switch (direction) {
        case "top":
          amount = hud.y + hud.height - handle.y
          break
        case "bottom":
          amount = handle.y + handle.height - hud.y
          break
        case "left":
          amount = hud.x + hud.width - handle.x
          break
        case "right":
          amount = handle.x + handle.width - hud.x
          break
      }
      if (amount > extend[direction]) {
        extend[direction] = amount
      }
    }
  }
  return extend
}

/** Per-direction stick amount (px) — how far to pull each handle inward
 *  to keep it visible inside the canvas viewport. Non-zero when the frame
 *  extends past the canvas edge entirely. */
export function computeSticks(
  rect: Rect,
  canvas: { width: number; height: number },
): Record<Direction, number> {
  return {
    top: Math.max(0, -rect.y),
    bottom: Math.max(0, rect.y + rect.height - canvas.height),
    left: Math.max(0, -rect.x),
    right: Math.max(0, rect.x + rect.width - canvas.width),
  }
}
