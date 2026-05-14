import type { AppContext } from "./types"
import type { LeafFrame, Rect } from "./viewport"
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
    /** Test-only hook exposed by App. Whole reactive context — used by
     *  Playwright tests to drive transport, inspect clip state, etc. */
    __appContext?: AppContext
  }
}

// @introspection/plugin-performance's published `src/index.ts` imports
// its prebuilt `dist/browser.iife.js` directly, which ships without a
// declaration file. tsc follows the import despite skipLibCheck and
// emits TS7016. Declaring the asset as a string blob keeps tsc happy.
declare module "@introspection/plugin-performance/dist/browser.iife.js" {
  const value: string
  export default value
}

export {}
