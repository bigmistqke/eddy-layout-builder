import type { Selection } from "./types"

// Handle dimensions in CSS pixels — derived from frame.module.css.
// Top / bottom handles are HANDLE_W wide × HANDLE_H tall, centered on the
// frame's top/bottom edge. Left / right handles are 90° rotated, so they
// occupy HANDLE_H × HANDLE_W centered on the frame's left/right edge.
const HANDLE_W = 100
const HANDLE_H = 60

// For all 4 handles to fit on a frame with no pairwise overlap:
//
//   • Top vs bottom (vertical pair):    frameH ≥ 2·HANDLE_H = 120
//   • Left vs right (horizontal pair):  frameW ≥ 2·HANDLE_H = 120
//   • Corner pairs (top vs left, etc.): frameW ≥ HANDLE_W + 2·HANDLE_H = 220
//                                       OR frameH ≥ HANDLE_W + 2·HANDLE_H
//
// Derivation for the corner case: top handle's horizontal range is
// [c − HANDLE_W/2, c + HANDLE_W/2]; the (rotated) left handle's horizontal
// range is [0, HANDLE_H]. For non-overlap, c − HANDLE_W/2 ≥ HANDLE_H
// → frameW ≥ HANDLE_W + 2·HANDLE_H.
// Buffer added to both bounds so frames are slightly bigger than the strict
// minimum — avoids floating-point drift flipping the same-frame rectsOverlap
// check from "touch" (no overlap) to "0.0001px overlap" (collision) at the
// boundary, which made handles inconsistently hidden.
const HANDLE_BUFFER = 20
const SAME_AXIS_MIN = 2 * HANDLE_H + HANDLE_BUFFER
const CROSS_PAIR_MIN = HANDLE_W + 2 * HANDLE_H + HANDLE_BUFFER

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

/** Cumulative un-transformed offset of `el` relative to `root`. Walks the offsetParent chain. */
function offsetRelativeToRoot(el: HTMLElement, root: HTMLElement) {
  let x = 0
  let y = 0
  let cur: HTMLElement | null = el
  while (cur && cur !== root) {
    x += cur.offsetLeft
    y += cur.offsetTop
    cur = cur.offsetParent as HTMLElement | null
  }
  return { x, y, width: el.offsetWidth, height: el.offsetHeight }
}

/**
 * Insets (in canvas-viewport pixels) of HUDs along each canvas edge. Used to
 * detect when a frame's natural position would put a directional handle
 * underneath a HUD by enough that the existing extend-into-HUD mechanism
 * can't compensate without making the same-axis handle pair overlap.
 */
export type HudInsets = { top: number; right: number; bottom: number; left: number }

export const NO_HUD_INSETS: HudInsets = { top: 0, right: 0, bottom: 0, left: 0 }

/**
 * Compute the constraint-correct viewport transform for a selected DOM element.
 *
 * `currentScale`: the canvas's current size multiplier — used to recover the
 * node's base (un-zoomed) measurements from `offsetWidth/Top`, which reflect
 * the currently rendered size (`base × currentScale`).
 *
 * `minScale`: minimum scale to apply regardless of handle-fit needs. When
 * already zoomed, callers pass `currentScale` here so the viewport never
 * zooms *out* on tap — only the back button does that. At minScale > 1 we
 * always return a non-identity transform that pans the new selection to
 * the canvas center at the chosen scale.
 *
 * `hudInsets`: how far each HUD intrudes into the canvas viewport from its
 * edge. Used to decide whether a frame's natural (un-translated) position
 * leaves enough room for handles + extends. If natural is fine, we return
 * identity — preserving the "no pan when not needed" UX. If natural would
 * cause the bottom (or top, etc.) handle's HUD-extend to push it through
 * the opposite-axis handle, we pan the frame to canvas center where extends
 * shrink to manageable.
 */
export function computeViewportTransform(
  node: HTMLElement,
  layoutRoot: HTMLElement,
  canvasW: number,
  canvasH: number,
  currentScale = 1,
  minScale = 1,
  hudInsets: HudInsets = NO_HUD_INSETS,
): ViewportTransform {
  const { x: rawX, y: rawY, width: rawW, height: rawH } = offsetRelativeToRoot(node, layoutRoot)
  if (rawW === 0 || rawH === 0) return IDENTITY_VIEWPORT

  // Recover base (un-zoomed) measurements.
  const nw = rawW / currentScale
  const nh = rawH / currentScale
  const nx = rawX / currentScale
  const ny = rawY / currentScale

  // Smallest multiplier at which all 4 handles fit without pairwise overlap.
  // Same-axis (top/bottom and left/right) requires both dims ≥ SAME_AXIS_MIN.
  // Corner pairs (top-vs-left, etc.) require at least ONE dim ≥ CROSS_PAIR_MIN.
  const handleScale = Math.max(
    SAME_AXIS_MIN / nw,
    SAME_AXIS_MIN / nh,
    Math.min(CROSS_PAIR_MIN / nw, CROSS_PAIR_MIN / nh),
  )

  const scale = Math.max(handleScale, minScale)

  // Identity-eligible (no zoom needed) — but check whether the frame's
  // *natural* position would leave room for handle extends against HUDs. If
  // a HUD-induced extend on one edge would push the same-axis handle pair
  // into overlap (e.g. bottom-row frame: bottom-handle extends up by HUD
  // height, eating into top-handle's territory), pan the frame to canvas
  // center where extends are symmetric and manageable.
  if (scale <= 1) {
    const top = ny
    const bottom = ny + nh
    const left = nx
    const right = nx + nw
    const extTop = Math.max(0, hudInsets.top - top)
    const extBottom = Math.max(0, bottom - (canvasH - hudInsets.bottom))
    const extLeft = Math.max(0, hudInsets.left - left)
    const extRight = Math.max(0, right - (canvasW - hudInsets.right))
    const verticalFits = nh >= SAME_AXIS_MIN + extTop + extBottom
    const horizontalFits = nw >= SAME_AXIS_MIN + extLeft + extRight
    if (verticalFits && horizontalFits) return IDENTITY_VIEWPORT
  }

  const nodeCenterX = (nx + nw / 2) * scale
  const nodeCenterY = (ny + nh / 2) * scale
  const x = canvasW / 2 - nodeCenterX
  const y = canvasH / 2 - nodeCenterY

  return { scale, x, y }
}

/** CSS translate string for `transform`. Caller applies the size multiplier
 *  separately via `width`/`height`. */
export function transformToCss(t: ViewportTransform) {
  return `translate(${t.x}px, ${t.y}px)`
}
