import {
  createMemo,
  For,
  type JSX,
  Match,
  merge,
  type ParentProps,
  Show,
  Switch,
  useContext,
} from "solid-js"
import { Context } from "../context"
import type { Container, Direction, Entity, HandleOp, HandleSpec } from "../types"
import { logAction, pathEquals } from "../utils"
import styles from "./node-component.module.css"
import { ArrowNotch } from "./notch"

function Frame(
  _props: ParentProps<{
    onClick?: JSX.EventHandlersElement<HTMLDivElement>["onClick"]
    handles?: HandleSpec[]
    style?: JSX.CSSProperties
    class?: string
    "data-path"?: string
    onAddFrame(direction: Direction, op: "append" | "split"): void
  }>,
) {
  const props = merge({ handles: [] }, _props)
  const context = useContext(Context)!

  // True iff this frame is the currently selected one. Equivalent to
  // "we have any handles to render," since handles() is empty for any
  // frame that isn't the selection's targeted scope.
  const isSelected = createMemo(() => props.handles.length > 0)

  function handleStyle(direction: Direction): JSX.CSSProperties | undefined {
    if (!isSelected()) {
      return undefined
    }
    const state = context.selectedHandlesState()
    const extend = state.extend[direction]
    const stick = state.stick[direction]
    if (extend === 0 && stick === 0) {
      return undefined
    }
    const style: Record<string, string> = {}
    if (extend > 0) {
      style["--extend"] = `${extend}px`
    }
    if (stick > 0) {
      style["--stick"] = `${stick}px`
    }
    return style as JSX.CSSProperties
  }

  return (
    <div
      onClick={props.onClick}
      style={props.style}
      class={[props.class, styles.frame]}
      data-path={props["data-path"]}
    >
      <Show when={!context.isAnimating()}>
        <For each={props.handles}>
          {handle => (
            <ArrowNotch
              direction={handle().dir}
              style={handleStyle(handle().dir)}
              onClick={() => props.onAddFrame(handle().dir, handle().op)}
            />
          )}
        </For>
      </Show>
      {props.children}
    </div>
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
    const tool = context.app.tool
    if (tool === null) {
      return []
    }

    const selection = context.app.selection
    if (selection === null) {
      return []
    }
    const targetedPath = selection.path.slice(0, selection.path.length - selection.depth)

    if (!pathEquals(props.path, targetedPath)) {
      return []
    }

    // Tool-driven op: in append all 4 arrows are `+`, in split all are
    // split. The actual semantics of "append" on a cross-axis arrow
    // (which wraps) is resolved in state.ts's handleAddFrame.
    const directions: Direction[] = ["top", "bottom", "left", "right"]

    return directions.map(direction => ({ dir: direction, op: tool }))
  })

  const isEditing = () => context.app.tool !== null

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
              isEditing()
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
          <Frame
            data-path={pathKey()}
            handles={handles()}
            class={isEditing() ? styles.layoutEntity : undefined}
            onAddFrame={(direction, op) => {
              logAction("add-frame", { path: props.path, direction, op })
              props.onAddFrame(props.path, direction, op)
            }}
            onClick={() => {
              if (!isEditing()) {
                return
              }
              logAction("tap-frame", { path: props.path })
              context.setSelection({ path: props.path, depth: 0 })
            }}
            style={{ background: entity().color }}
          />
        )}
      </Match>
    </Switch>
  )
}
