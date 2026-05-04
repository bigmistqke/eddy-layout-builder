export type Container = {
  type: "container"
  direction: "horizontal" | "vertical"
  children: Array<Entity | Container>
}
export type Entity = { type: "entity"; color: string }
export type Node = Container | Entity

export type AppView = { type: "recording" } | { type: "layout"; mode: "append" | "split" }
export type AppState = { view: AppView }
