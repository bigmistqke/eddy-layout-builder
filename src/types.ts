import type { Accessor } from "solid-js"
import type { ClipStore } from "./clips/store"
import type { Preview } from "./clips/preview"
import type { Transport } from "./clips/transport"
import type { ProjectsStore } from "./state/projects"
import type { HudRect, ViewportTransform } from "./viewport"

export type Container = {
  type: "container"
  direction: "horizontal" | "vertical"
  children: Array<Entity | Container>
}
/** Normalised RGB triple, each component in [0, 1]. Stored on Entity
 *  in this shape so renderers don't have to parse a CSS string per
 *  frame. */
export type Rgb = [number, number, number]

export interface Entity {
  type: "entity"
  id: string
  color: Rgb
}
export type Node = Container | Entity

/** Layout-editing sub-mode. Non-null = "Edit mode" is active (see the
 *  Edit toggle in the main HUD); the value picks which add-frame
 *  operation the handles perform. The audio slider mounts whenever a
 *  cell is selected, independent of this. */
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
/** A HUD's long axis — the direction along which it extends. Horizontal
 *  HUDs (e.g. a breadcrumb across the top edge) attach to the top/bottom
 *  edges; vertical HUDs attach to the left/right edges. Used by viewport
 *  math to decide between extending a handle past the HUD vs zooming the
 *  selected frame to fit (when the handle's escape axis matches the
 *  HUD's, extending can't clear the collision). */
export type HudOrientation = "horizontal" | "vertical"
export interface Selection {
  path: number[]
  depth: number
  /** Whether the selected cell should drive the live camera preview.
   *  Decoupled from path/depth so the post-record state (cell selected,
   *  showing its clip's frame 0 instead of the camera) is expressible.
   *  Click toggles re-aim this. */
  preview: boolean
}

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

  /** Returns a ref-setter for a HUD slot. Wire as
   *  `ref={context.setHudElement("horizontal")}`. The orientation is
   *  the HUD's long axis (see `HudOrientation`). Solid calls the setter
   *  with the element on mount and `undefined` on unmount. */
  setHudElement: (
    orientation: HudOrientation,
  ) => (element: HTMLElement | undefined) => void

  /** Bounding rects of all mounted HUDs in canvas-relative coords, each
   *  tagged with its long-axis orientation. Driven by a single
   *  ResizeObserver over every HUD element plus the canvas viewport
   *  element. */
  hudRects: Accessor<HudRect[]>
  /** Ref-setter for the canvas viewport element — the box HUD rects are
   *  measured relative to, and the second input to the HUD ResizeObserver. */
  setCanvasViewportElement: (element: HTMLElement | undefined) => void

  /** True while the canvas viewport is mid-transition. Frames hide their
   *  handles during this window so ResizeObserver-driven collision rechecks
   *  don't toggle handle visibility under the animation. */
  isAnimating: Accessor<boolean>
  setIsAnimating: (animating: boolean) => void
  selectedHandlesState: Accessor<SelectedHandlesState>
  setSelectedHandlesState: (state: SelectedHandlesState) => void

  viewport: Accessor<ViewportTransform>
  setViewport: (next: ViewportTransform) => void

  setTool: (tool: Tool) => void
  /** Remove the currently selected node. Containers with one child
   *  collapse to that child on the way up; an empty root becomes a
   *  fresh Entity. No-op when nothing is selected. */
  deleteSelection: () => void
  handleAddFrame: (path: number[], direction: Direction, op: HandleOp) => void

  clips: ClipStore
  transport: Transport
  preview: Preview
  projects: ProjectsStore
  songLength: Accessor<number | null>
  setSongLength(next: number | null): void

  /** Derived: the cell id where the live camera preview should paint,
   *  or null. A memo over `selection.preview`, `selection.path`,
   *  `app.tool`, and `app.layout`. Consumers (the WebGL render loop)
   *  read this as the single source of truth. */
  previewTargetCellId: Accessor<string | null>
}
