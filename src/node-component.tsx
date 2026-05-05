import { omit } from "@solidjs/signals"
import type { ComponentProps, JSX } from "solid-js"
import { createMemo, For, Match, Switch, useContext } from "solid-js"
import styles from "./app.module.css"
import { Context } from "./context"
import { Frame } from "./frame"
import type { Container, Direction, Entity, Selection } from "./types"
import { resolveNode } from "./utils"

function pathEquals(a: number[], b: number[]) {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function isNodeActive(path: number[], selection: Selection) {
  const pathLength = selection.path.length - selection.depth
  return (
    pathLength === path.length &&
    path.slice(0, pathLength).findIndex((value, index) => value !== selection.path[index]) === -1
  )
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
  onAppend(path: number[], direction: Direction): void
  onSplit(path: number[], direction: Direction): void
  path: Array<number>
}) {
  const context = useContext(Context)!

  const pathKey = createMemo(() => props.path.join("."))

  const handles = createMemo(() => {
    const empty = { directions: [] as Direction[], buttons: [] as Direction[] }
    if (context.app.view.type !== "layout") return empty
    const s = context.selection
    const { mode } = context.app.view as { type: "layout"; mode: "append" | "split" }
    const targetedPath = s.path.slice(0, s.path.length - s.depth)

    if (mode === "split") {
      if (!pathEquals(props.path, targetedPath)) return empty
      return {
        directions: ["top", "bottom", "left", "right"] as Direction[],
        buttons: [] as Direction[],
      }
    }

    try {
      const targeted = resolveNode(context.app.layout, targetedPath)
      const containerPath = targeted.type === "container" ? targetedPath : targetedPath.slice(0, -1)
      const isDirectChild =
        props.path.length === containerPath.length + 1 &&
        pathEquals(props.path.slice(0, -1), containerPath)
      if (!isDirectChild) return empty
      const container = resolveNode(context.app.layout, containerPath) as Container
      const childIdx = props.path[props.path.length - 1]
      const isFirst = childIdx === 0
      const isLast = childIdx === container.children.length - 1

      if (container.direction === "horizontal") {
        const directions = isFirst ? (["left", "right"] as Direction[]) : (["right"] as Direction[])
        const buttons = (!isLast ? ["right"] : []) as Direction[]
        return { directions, buttons }
      } else {
        const directions = isFirst
          ? (["top", "bottom"] as Direction[])
          : (["bottom"] as Direction[])
        const buttons = (!isLast ? ["bottom"] : []) as Direction[]
        return { directions, buttons }
      }
    } catch {
      return empty
    }
  })

  const layoutView = () =>
    context.app.view.type === "layout"
      ? (context.app.view as { type: "layout"; mode: "append" | "split" })
      : null

  const inLayoutView = () => context.app.view.type === "layout"

  return (
    <Switch>
      <Match when={props.layout?.type === "container" && props.layout}>
        {layout => (
          <Frame
            handleDirections={handles().directions}
            buttonDirections={handles().buttons}
            style={{ "flex-direction": layout().direction === "horizontal" ? "row" : "column" }}
            onAddFrame={direction =>
              layoutView()?.mode === "append"
                ? props.onAppend(props.path, direction)
                : props.onSplit(props.path, direction)
            }
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
                  onAppend={props.onAppend}
                  onSplit={props.onSplit}
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
            handleDirections={handles().directions}
            buttonDirections={handles().buttons}
            class={inLayoutView() ? styles.layoutEntity : undefined}
            onAddFrame={direction =>
              layoutView()?.mode === "append"
                ? props.onAppend(props.path, direction)
                : props.onSplit(props.path, direction)
            }
            onClick={() => {
              const lv = layoutView()
              if (!lv) return
              if (lv.mode === "append") {
                if (isNodeActive(props.path, { ...context.selection, depth: 0 })) {
                  context.setSelection(s => ({
                    ...s,
                    depth: (s.depth % s.path.length) + 1,
                  }))
                } else {
                  context.setSelection(() => ({ path: props.path, depth: 1 }))
                }
              } else {
                if (isNodeActive(props.path, { ...context.selection, depth: 0 })) {
                  context.setSelection(s => ({
                    ...s,
                    depth: (s.depth + 1) % (s.path.length + 1),
                  }))
                } else {
                  context.setSelection(() => ({ path: props.path, depth: 0 }))
                }
              }
            }}
          />
        )}
      </Match>
    </Switch>
  )
}
