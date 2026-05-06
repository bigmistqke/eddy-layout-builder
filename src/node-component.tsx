import { omit } from "@solidjs/signals"
import type { ComponentProps, JSX } from "solid-js"
import { createMemo, For, Match, Switch, useContext } from "solid-js"
import styles from "./node-component.module.css"
import { Context } from "./context"
import { Frame } from "./frame"
import type { Container, Direction, Entity, HandleOp, HandleSpec } from "./types"
import { logAction, resolveNode } from "./utils"

function pathEquals(a: number[], b: number[]) {
  return a.length === b.length && a.every((v, i) => v === b[i])
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
  path: Array<number>
}) {
  const context = useContext(Context)!

  const pathKey = createMemo(() => props.path.join("."))

  const handles = createMemo<HandleSpec[]>(() => {
    if (context.app.view.type !== "layout") return []
    const s = context.selection
    const targetedPath = s.path.slice(0, s.path.length - s.depth)
    if (!pathEquals(props.path, targetedPath)) return []

    // Mode-driven op: in append mode all 4 arrows are `+`, in split mode all
    // are split. The actual semantics of "append" on a cross-axis arrow
    // (which wraps) is resolved in app.tsx's handleAddFrame.
    const op: HandleOp = context.app.view.mode
    const directions: Direction[] = ["top", "bottom", "left", "right"]
    return directions.map(dir => ({ dir, op }))
  })

  const inLayoutView = () => context.app.view.type === "layout"

  return (
    <Switch>
      <Match when={props.layout?.type === "container" && props.layout}>
        {layout => (
          <Frame
            handles={handles()}
            style={{ "flex-direction": layout().direction === "horizontal" ? "row" : "column" }}
            onAddFrame={(direction, op) => {
              logAction("add-frame", { path: props.path, direction, op })
              props.onAddFrame(props.path, direction, op)
            }}
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
            onAddFrame={(direction, op) => {
              logAction("add-frame", { path: props.path, direction, op })
              props.onAddFrame(props.path, direction, op)
            }}
            onClick={() => {
              if (!inLayoutView()) return
              logAction("tap-frame", { path: props.path })
              context.setSelection(() => ({ path: props.path, depth: 0 }))
            }}
          />
        )}
      </Match>
    </Switch>
  )
}
