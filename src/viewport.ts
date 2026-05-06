import {
  HANDLE_BUFFER,
  HANDLE_H,
  HANDLE_W,
  ROOT_PADDING,
  SAME_AXIS_MIN,
  SIBLING_GAP,
  CROSS_PAIR_MIN,
} from "./ui-constants"
import type { Container, Direction, Node, Selection } from "./types"

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
  if (len <= 0) return ""
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
export function computeViewportTransform(
  baseRect: Rect,
  canvas: { w: number; h: number },
  minScale = 1,
  hudRects: Rect[] = [],
): ViewportTransform {
  if (baseRect.w === 0 || baseRect.h === 0) return IDENTITY_VIEWPORT

  const handleScale = Math.max(
    SAME_AXIS_MIN / baseRect.w,
    SAME_AXIS_MIN / baseRect.h,
    Math.min(CROSS_PAIR_MIN / baseRect.w, CROSS_PAIR_MIN / baseRect.h),
  )

  const scale = Math.max(handleScale, minScale)

  // Identity-eligible (no zoom needed) — but check whether the frame's
  // handles at their natural positions overlap any HUDs in a way that
  // makes a same-axis handle pair overlap each other. If yes, pan to
  // canvas center; otherwise identity.
  if (scale <= 1) {
    const naturalExt = computeExtends(baseRect, hudRects)
    const verticalFits = baseRect.h >= SAME_AXIS_MIN + naturalExt.top + naturalExt.bottom
    const horizontalFits = baseRect.w >= SAME_AXIS_MIN + naturalExt.left + naturalExt.right
    if (verticalFits && horizontalFits) return IDENTITY_VIEWPORT
  }

  // Pan the frame's center to canvas center.
  const nodeCenterX = (baseRect.x + baseRect.w / 2) * scale
  const nodeCenterY = (baseRect.y + baseRect.h / 2) * scale
  const x = canvas.w / 2 - nodeCenterX
  const y = canvas.h / 2 - nodeCenterY
  return { scale, x, y }
}

/** CSS translate string for `transform`. Caller applies the size multiplier
 *  separately via `width`/`height`. */
export function transformToCss(t: ViewportTransform) {
  return `translate(${t.x}px, ${t.y}px)`
}

/** Axis-aligned rect in canvas-local coordinates. Coordinates are in CSS
 *  pixels of the un-zoomed canvas. */
export type Rect = { x: number; y: number; w: number; h: number }

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
  layout: Container,
  path: number[],
  canvas: { w: number; h: number },
): Rect {
  let rect: Rect = {
    x: ROOT_PADDING,
    y: ROOT_PADDING,
    w: canvas.w - 2 * ROOT_PADDING,
    h: canvas.h - 2 * ROOT_PADDING,
  }
  let current: Node = layout
  for (const idx of path) {
    if (current.type !== "container") break
    const n = current.children.length
    const totalGap = SIBLING_GAP * (n - 1)
    if (current.direction === "horizontal") {
      const childW = (rect.w - totalGap) / n
      rect = {
        x: rect.x + idx * (childW + SIBLING_GAP),
        y: rect.y,
        w: childW,
        h: rect.h,
      }
    } else {
      const childH = (rect.h - totalGap) / n
      rect = {
        x: rect.x,
        y: rect.y + idx * (childH + SIBLING_GAP),
        w: rect.w,
        h: childH,
      }
    }
    current = current.children[idx]
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
    w: rect.w * scale,
    h: rect.h * scale,
  }
}

/** Compute each handle's natural rect (in canvas-relative coords) given
 *  the frame's rect. Mirrors the CSS positioning of ArrowNotch:
 *  top/bottom centered horizontally on the respective edge; left/right
 *  rotated 90° so dimensions swap. */
export function handleRects(frame: Rect): Record<Direction, Rect> {
  const cx = frame.x + frame.w / 2
  const cy = frame.y + frame.h / 2
  return {
    top: { x: cx - HANDLE_W / 2, y: frame.y, w: HANDLE_W, h: HANDLE_H },
    bottom: {
      x: cx - HANDLE_W / 2,
      y: frame.y + frame.h - HANDLE_H,
      w: HANDLE_W,
      h: HANDLE_H,
    },
    left: { x: frame.x, y: cy - HANDLE_W / 2, w: HANDLE_H, h: HANDLE_W },
    right: {
      x: frame.x + frame.w - HANDLE_H,
      y: cy - HANDLE_W / 2,
      w: HANDLE_H,
      h: HANDLE_W,
    },
  }
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** Per-direction extend amount (px) for a frame's handle notches against
 *  HUDs. For each handle, finds the maximum overlap with any HUD on that
 *  handle's outward side; that distance is how far the notch needs to
 *  grow to push its visible portion past the HUD. */
export function computeExtends(frame: Rect, hudRects: Rect[]): Record<Direction, number> {
  const handles = handleRects(frame)
  const out: Record<Direction, number> = { top: 0, bottom: 0, left: 0, right: 0 }
  for (const hud of hudRects) {
    for (const dir of ["top", "bottom", "left", "right"] as Direction[]) {
      const h = handles[dir]
      if (!rectsOverlap(h, hud)) continue
      let e = 0
      switch (dir) {
        case "top":
          e = hud.y + hud.h - h.y
          break
        case "bottom":
          e = h.y + h.h - hud.y
          break
        case "left":
          e = hud.x + hud.w - h.x
          break
        case "right":
          e = h.x + h.w - hud.x
          break
      }
      if (e > out[dir]) out[dir] = e
    }
  }
  return out
}

/** Per-direction stick amount (px) — how far to pull each handle inward
 *  to keep it visible inside the canvas viewport. Non-zero when the frame
 *  extends past the canvas edge entirely. */
export function computeSticks(
  rect: Rect,
  canvas: { w: number; h: number },
): Record<Direction, number> {
  return {
    top: Math.max(0, -rect.y),
    bottom: Math.max(0, rect.y + rect.h - canvas.h),
    left: Math.max(0, -rect.x),
    right: Math.max(0, rect.x + rect.w - canvas.w),
  }
}
