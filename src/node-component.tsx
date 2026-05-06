import { omit } from "@solidjs/signals"
import type { ComponentProps, JSX } from "solid-js"
import { createMemo, For, Match, Switch, useContext } from "solid-js"
import styles from "./app.module.css"
import { Context } from "./context"
import { Frame } from "./frame"
import type { Container, Direction, Entity, HandleOp, HandleSpec } from "./types"
import { resolveNode } from "./utils"

function pathEquals(a: number[], b: number[]) {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function opForDirection(
  dir: Direction,
  parentDirection: "horizontal" | "vertical",
): HandleOp {
  const dirAxis = dir === "left" || dir === "right" ? "horizontal" : "vertical"
  return dirAxis === parentDirection ? "append" : "split"
}

function EntityFrame(
  props: ComponentProps<typeof Frame> & {
    entity: Entity
  },
) {
  const rest = omit(props, "entity")
  return (
    <Frame
      {...rest}
      style={{ ...(props.style as JSX.CSSProperties), background: props.entity?.color }}
    />
  )
}

export function NodeComponent(props: {
  layout: Container | Entity
  onAddFrame(path: number[], direction: Direction, op: HandleOp): void
  onSwapDirection(path: number[]): void
  path: Array<number>
}) {
  const context = useContext(Context)!

  const pathKey = createMemo(() => props.path.join("."))

  const handles = createMemo<HandleSpec[]>(() => {
    if (context.app.view.type !== "layout") return []
    const s = context.selection
    const targetedPath = s.path.slice(0, s.path.length - s.depth)
    if (!pathEquals(props.path, targetedPath)) return []

    // Parent direction: for non-root, the container that holds this frame.
    // For root selection, root's own direction (root acts as its own parent).
    const parentDirection: "horizontal" | "vertical" =
      props.path.length === 0
        ? context.app.layout.direction
        : (resolveNode(context.app.layout, props.path.slice(0, -1)) as Container).direction

    const directions: Direction[] = ["top", "bottom", "left", "right"]
    return directions.map(dir => ({ dir, op: opForDirection(dir, parentDirection) }))
  })

  const isSelected = () => handles().length > 0
  const inLayoutView = () => context.app.view.type === "layout"

  return (
    <Switch>
      <Match when={props.layout?.type === "container" && props.layout}>
        {layout => (
          <Frame
            handles={handles()}
            style={{ "flex-direction": layout().direction === "horizontal" ? "row" : "column" }}
            onAddFrame={(direction, op) => props.onAddFrame(props.path, direction, op)}
            onSwapDirection={isSelected() ? () => props.onSwapDirection(props.path) : undefined}
            class={[
              styles.container,
              inLayoutView()
                ? props.path.length === 0
                  ? styles.layoutContainerRoot
                  : styles.layoutContainer
                : "",
            ].join(" ")}
            data-path={pathKey()}
          >
            <For each={layout().children}>
              {(child, index) => (
                <NodeComponent
                  layout={child()}
                  path={[...props.path, index()]}
                  onAddFrame={props.onAddFrame}
                  onSwapDirection={props.onSwapDirection}
                />
              )}
            </For>
          </Frame>
        )}
      </Match>
      <Match when={props.layout?.type === "entity" && props.layout}>
        {entity => (
          <EntityFrame
            entity={entity()}
            data-path={pathKey()}
            handles={handles()}
            class={inLayoutView() ? styles.layoutEntity : undefined}
            onAddFrame={(direction, op) => props.onAddFrame(props.path, direction, op)}
            onSwapDirection={isSelected() ? () => props.onSwapDirection(props.path) : undefined}
            onClick={() => {
              if (!inLayoutView()) return
              context.setSelection(() => ({ path: props.path, depth: 0 }))
            }}
          />
        )}
      </Match>
    </Switch>
  )
}
