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

/** Per-direction extend amount (px) for a frame's handle notches against
 *  the HUDs on each canvas edge. Non-zero when the frame's edge is
 *  underneath the corresponding HUD's interior face. */
export function computeExtends(
  rect: Rect,
  canvas: { w: number; h: number },
  hudInsets: HudInsets,
): Record<Direction, number> {
  return {
    top: Math.max(0, hudInsets.top - rect.y),
    bottom: Math.max(0, rect.y + rect.h - (canvas.h - hudInsets.bottom)),
    left: Math.max(0, hudInsets.left - rect.x),
    right: Math.max(0, rect.x + rect.w - (canvas.w - hudInsets.right)),
  }
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
