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
  observeFrame: (el: HTMLElement, onResize: () => void) => () => void
  registerCollidable: (el: HTMLElement, kind: CollisionKind) => () => void
  findCollisions: (el: HTMLElement) => CollisionHit[]
  /** Subscribe to "registry changed" notifications. Frames register their
   *  checkAllHandles callback here so they re-evaluate whenever any
   *  collidable mounts or unmounts. Returns a cleanup. */
  registerUpdateCollision: (cb: () => void) => () => void
  isCanvasZoomed: Accessor<boolean>
  setIsCanvasZoomed: (zoomed: boolean) => void
}
