import { HANDLE_H, HANDLE_W, ROOT_PADDING, SIBLING_GAP } from "./constants"
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
/** Find scale s such that the selected frame, at scale s, fits the target
 *  box (canvas inset by one HUD height on each side) with one axis exactly
 *  filling the target. Iterative because CSS padding/gap are fixed pixels —
 *  flex math means rect dims at scale s are NOT (rect at 1) × s. Each step
 *  multiplies scale by the binding axis's deficit ratio; converges in 1–3
 *  iterations typically, capped to avoid runaway. */
const MAX_SCALE = 10000
const MAX_FIT_ITER = 20
const FRAME_PADDING = HANDLE_H
function findFitToTargetScale(
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
      if (scale >= MAX_SCALE) {
        return MAX_SCALE
      }
      continue
    }
    const widthFactor = targetWidth / rect.width
    const heightFactor = targetHeight / rect.height
    const factor = Math.min(widthFactor, heightFactor)
    if (Math.abs(factor - 1) < 0.001) {
      return scale
    }
    scale *= factor
    if (scale >= MAX_SCALE) {
      return MAX_SCALE
    }
  }
  return Math.min(scale, MAX_SCALE)
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

  const fitScale = findFitToTargetScale(layout, path, canvas)
  const scale = Math.max(fitScale, minScale)

  // Identity-eligible (no zoom needed) — frame is already at-or-larger-than
  // the target box. Skip the pan-to-center if handles clear HUDs naturally;
  // otherwise pan so the stick/extend logic can keep them visible.
  if (scale <= 1) {
    const naturalExt = computeExtends(baseRect, hudRects)
    const noHudOverlap =
      naturalExt.top === 0 &&
      naturalExt.bottom === 0 &&
      naturalExt.left === 0 &&
      naturalExt.right === 0
    if (noHudOverlap) {
      return IDENTITY_VIEWPORT
    }
  }

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
