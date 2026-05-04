export type Container = {
  type: "container"
  direction: "horizontal" | "vertical"
  children: Array<Entity | Container>
}
export type Entity = { type: "entity"; color: string }
export type Node = Container | Entity

export type Mode = "append" | "split"
export type View = "recording" | "layout-builder"
