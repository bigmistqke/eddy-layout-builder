import type { Selection } from "./types"

// Handle dimensions in CSS pixels — derived from frame.module.css and index.css.
// `--hud-height-notch` is 60px; the notch backdrop default width is 100px.
// These give the worst-case footprint of one handle in viewport units.
// If frame.module.css changes, update these to match.
const HANDLE_VIEWPORT_W = 100
const HANDLE_VIEWPORT_H = 60

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
 * Compute the constraint-correct viewport transform for a selected DOM element.
 *
 * The viewport only enlarges the canvas when *handles would not fit* at native
 * size — i.e., the selected node would render smaller than the worst-case
 * handle footprint. Otherwise we return identity (no scale, no pan), so a
 * normal-sized selection doesn't move the camera at all.
 *
 * `currentScale` must be passed when the canvas is already enlarged so we can
 * recover the node's *base* (un-zoomed) dimensions: `offsetWidth`/`offsetTop`
 * reflect the currently rendered size, which is `base * currentScale`. Without
 * this, recomputing the viewport while already zoomed would oscillate between
 * scale 1 and the target scale (the rendered size hits the threshold from
 * different sides at different scales).
 */
export function computeViewportTransform(
  node: HTMLElement,
  layoutRoot: HTMLElement,
  canvasW: number,
  canvasH: number,
  currentScale = 1,
): ViewportTransform {
  const { x: rawX, y: rawY, width: rawW, height: rawH } = offsetRelativeToRoot(node, layoutRoot)
  if (rawW === 0 || rawH === 0) return IDENTITY_VIEWPORT

  // Recover base (un-zoomed) measurements.
  const nw = rawW / currentScale
  const nh = rawH / currentScale
  const nx = rawX / currentScale
  const ny = rawY / currentScale

  // Smallest multiplier at which two opposing handles no longer overlap.
  const handleScale = Math.max((2 * HANDLE_VIEWPORT_W) / nw, (2 * HANDLE_VIEWPORT_H) / nh)

  // Below 1 means the handles already fit at native size; nothing to do.
  if (handleScale <= 1) return IDENTITY_VIEWPORT

  const scale = handleScale
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
