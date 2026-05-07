import type { Accessor } from "solid-js"
import type { Rect } from "./viewport"

export type Container = {
  type: "container"
  direction: "horizontal" | "vertical"
  children: Array<Entity | Container>
}
export type Entity = { type: "entity"; color: string }
export type Node = Container | Entity

/** Layout-editing tool. When `null`, frames are read-only — no handles
 *  render and tapping a frame is a no-op. */
export type Tool = "append" | "split" | null
export type AppState = {
  /** Root of the layout tree. Starts as a single Entity; becomes a
   *  Container as soon as the user splits/appends. */
  layout: Node
  tool: Tool
  /** `null` means no frame is selected — no handles render and the
   *  canvas sits at identity. Cleared by the contextual close button. */
  selection: Selection | null
}

export type Direction = "top" | "bottom" | "left" | "right"
export type HudKind = "main" | "breadcrumb" | "contextual"
export type Selection = { path: Array<number>; depth: number }

/** Operation a directional handle performs when tapped. */
export type HandleOp = "append" | "split"
export type HandleSpec = { dir: Direction; op: HandleOp }

/** Per-direction extend (HUD overlap) and stick (canvas overflow) for the
 *  currently selected frame's handles. Owned by layout-builder; read by
 *  the selected Frame to apply via --extend / --stick CSS variables. */
export type SelectedHandlesState = {
  extend: Record<Direction, number>
  stick: Record<Direction, number>
}

export type AppContext = {
  app: AppState
  setSelection: (next: Selection | null) => void

  isCanvasZoomed: Accessor<boolean>
  setIsCanvasZoomed: (zoomed: boolean) => void

  /** Returns a ref-setter for the named HUD slot. Wire as
   *  `ref={context.setHudElement("breadcrumb")}` etc. */
  setHudElement: (kind: HudKind) => (el: HTMLElement | undefined) => void

  /** Bounding rects of all mounted HUDs in canvas-relative coords. Used
   *  by viewport math to detect handle/HUD overlap. */
  computeHudRects: (canvasRect: DOMRect) => Rect[]

  /** True while the canvas viewport is mid-transition. Frames hide their
   *  handles during this window so ResizeObserver-driven collision rechecks
   *  don't toggle handle visibility under the animation. */
  isAnimating: Accessor<boolean>
  setIsAnimating: (animating: boolean) => void
  selectedHandlesState: Accessor<SelectedHandlesState>
  setSelectedHandlesState: (state: SelectedHandlesState) => void

  setTool: (tool: Tool) => void
  /** Remove the currently selected node. Containers with one child
   *  collapse to that child on the way up; an empty root becomes a
   *  fresh Entity. No-op when nothing is selected. */
  deleteSelection: () => void
  handleAddFrame: (path: number[], direction: Direction, op: HandleOp) => void
}
