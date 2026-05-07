import type { Rect } from "./viewport"
import type { LeafFrame } from "./viewport"
import type { ViewportState } from "./webgl/renderer"

declare global {
  interface Window {
    /** Test-only hook exposed by the WebGL Canvas component. Returns a
     *  snapshot of the layout the renderer just drew: every leaf entity
     *  with its canvas-local rect + color, the selected node's rect (if
     *  any), the current viewport transform, and the canvas's
     *  bounding-client-rect. Tests apply `viewport.scale` + `viewport.x/y`
     *  to leaf rects to get screen-space positions. */
    __layoutFrames?: () => {
      leaves: LeafFrame[]
      selectedRect: Rect | null
      viewport: ViewportState
      canvas: DOMRect
    }
  }
}

export {}
