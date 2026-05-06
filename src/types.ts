import type { StoreSetter } from "@solidjs/signals"
import type { Accessor } from "solid-js"
import type { CollisionHit, CollisionKind } from "./collision"

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
  /** The canvas viewport element (the visible scrollport — NOT the layout
   *  inner that gets translated/scaled). Used by frames to compute "is my
   *  handle off-screen?" sticking. */
  canvasEl: Accessor<HTMLElement | undefined>
  setCanvasEl: (el: HTMLElement | undefined) => void
  observeFrame: (el: HTMLElement, onResize: () => void) => () => void
  registerCollidable: (el: HTMLElement, kind: CollisionKind) => () => void
  findCollisions: (el: HTMLElement) => CollisionHit[]
  /** Subscribe to "registry changed" notifications. Frames register their
   *  checkAllHandles callback here so they re-evaluate whenever any
   *  collidable mounts or unmounts. Returns a cleanup. */
  registerUpdateCollision: (cb: () => void) => () => void
  /** Manually trigger all collision-update subscribers. Use after a viewport
   *  change so frames recompute their handle/HUD overlaps once the canvas
   *  has settled at its new scale. */
  requestCollisionUpdate: () => void
  isCanvasZoomed: Accessor<boolean>
  setIsCanvasZoomed: (zoomed: boolean) => void
  /** True while the canvas viewport is mid-transition. Frames hide their
   *  handles during this window so ResizeObserver-driven collision rechecks
   *  don't toggle handle visibility under the animation. */
  isAnimating: Accessor<boolean>
  setIsAnimating: (animating: boolean) => void
}
