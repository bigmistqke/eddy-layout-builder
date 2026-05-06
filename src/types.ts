import type { StoreSetter } from "@solidjs/signals"
import type { Accessor } from "solid-js"

export type Container = {
  type: "container"
  direction: "horizontal" | "vertical"
  children: Array<Entity | Container>
}
export type Entity = { type: "entity"; color: string }
export type Node = Container | Entity

export type AppView = { type: "recording" } | { type: "layout"; mode: "append" | "split" }
export type AppState = { view: AppView; layout: Container }

export type Direction = "top" | "bottom" | "left" | "right"
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
  selection: Selection
  setSelection: StoreSetter<Selection>
  app: AppState
  setApp: StoreSetter<AppState>
  bottomBarEl: Accessor<HTMLElement | undefined>
  setBottomBarEl: (el: HTMLElement | undefined) => void
  breadcrumbEl: Accessor<HTMLElement | undefined>
  setBreadcrumbEl: (el: HTMLElement | undefined) => void
  contextualToolbarEl: Accessor<HTMLElement | undefined>
  setContextualToolbarEl: (el: HTMLElement | undefined) => void
  isCanvasZoomed: Accessor<boolean>
  setIsCanvasZoomed: (zoomed: boolean) => void
  /** True while the canvas viewport is mid-transition. Frames hide their
   *  handles during this window so ResizeObserver-driven collision rechecks
   *  don't toggle handle visibility under the animation. */
  isAnimating: Accessor<boolean>
  setIsAnimating: (animating: boolean) => void
  selectedHandlesState: Accessor<SelectedHandlesState>
  setSelectedHandlesState: (state: SelectedHandlesState) => void

  setView(view: AppView): void
  handleAddFrame: (path: number[], direction: Direction, op: HandleOp) => void
}
