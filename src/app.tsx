import type { StoreSetter } from "@solidjs/signals"
import { omit } from "@solidjs/signals"
import {
  type Accessor,
  ComponentProps,
  createContext,
  createMemo,
  createSignal,
  createStore,
  For,
  Match,
  Show,
  Switch,
  useContext,
} from "solid-js"
import styles from "./app.module.css"
import { Frame, Notch } from "./frame"
import { LayoutBuilder } from "./layout-builder"
import type { Container, Entity, Mode, Node, View } from "./types"

function RecordIcon() {
  return (
    <svg width="38" height="37" viewBox="0 0 38 37" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M34 18.5C34 10.5918 27.3855 4 19 4C10.6145 4 4 10.5918 4 18.5C4 26.4082 10.6145 33 19 33V37C8.50659 37 0 28.7173 0 18.5C0 8.28273 8.50659 0 19 0C29.4934 0 38 8.28273 38 18.5C38 28.7173 29.4934 37 19 37V33C27.3855 33 34 26.4082 34 18.5Z" fill="#E94949"/>
    </svg>
  )
}

function PlayIcon() {
  return (
    <svg width="31" height="35" viewBox="0 0 31 35" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M0 1.40616C0.0001188 0.320836 1.20893 -0.353989 2.16895 0.195213L30.2891 16.2891C31.237 16.8318 31.237 18.1682 30.2891 18.7109L2.16895 34.8048L1.98633 34.8937C1.12401 35.2431 0.140842 34.6942 0.0136719 33.7921L0 33.5938V1.40616ZM3 30.8721L26.3652 17.5L3 4.12688V30.8721Z" fill="#D3D3D3"/>
    </svg>
  )
}

type Selection = { path: Array<number>; depth: number }

export const Context = createContext<{
  layout: Container
  selection: Selection
  setSelection: StoreSetter<Selection>
  mode: () => Mode
  setMode: (mode: Mode) => void
  view: () => View
  bottomBarEl: Accessor<HTMLElement | undefined>
  setBottomBarEl: (el: HTMLElement | undefined) => void
}>()

function pathEquals(a: number[], b: number[]) {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function cloneNode(node: Node): Node {
  if (node.type === "entity") return { ...node }
  return { type: "container", direction: node.direction, children: node.children.map(cloneNode) }
}

function resolveNode(layout: Container, path: number[]) {
  let current: Entity | Container = layout

  for (let i = 0; i < path.length; i++) {
    if (current.type !== "container") {
      throw new Error("Unexpected entity node")
    }
    current = current.children[path[i]]
  }

  return current
}

function createEntity(): Entity {
  return {
    type: "entity",
    color: `rgb(${Math.random() * 100 + 150}, ${Math.random() * 100 + 150}, ${Math.random() * 100 + 150})`,
  }
}

function EntityFrame(
  props: ComponentProps<typeof Frame> & {
    entity: Entity
  },
) {
  const rest = omit(props, "entity")
  return <Frame style={{ background: props.entity?.color }} {...rest} />
}

function isNodeActive(path: number[], selection: Selection) {
  const pathLength = selection.path.length - selection.depth

  return (
    pathLength === path.length &&
    path.slice(0, pathLength).findIndex((value, index) => value !== selection.path[index]) === -1
  )
}

type Direction = "top" | "bottom" | "left" | "right"

function NodeComponent(props: {
  layout: Node
  onAppend(path: number[], direction: Direction): void
  onSplit(path: number[], direction: Direction): void
  path: Array<number>
}) {
  const context = useContext(Context)!

  const handles = createMemo(() => {
    const empty = { directions: [] as Direction[], buttons: [] as Direction[] }
    if (context.view() !== "layout-builder") return empty
    const s = context.selection
    const m = context.mode()
    const targetedPath = s.path.slice(0, s.path.length - s.depth)

    if (m === "split") {
      if (!pathEquals(props.path, targetedPath)) return empty
      return { directions: ["top", "bottom", "left", "right"] as Direction[], buttons: [] as Direction[] }
    }

    // Append mode: show edge handles on direct children of the targeted container.
    // First child gets leading + trailing; others get only trailing.
    // Outer edges (before first, after last) use ArrowNotch; inner edges use EdgeButton.
    try {
      const targeted = resolveNode(context.layout, targetedPath)
      const containerPath = targeted.type === "container" ? targetedPath : targetedPath.slice(0, -1)
      const isDirectChild =
        props.path.length === containerPath.length + 1 &&
        pathEquals(props.path.slice(0, -1), containerPath)
      if (!isDirectChild) return empty
      const container = resolveNode(context.layout, containerPath) as Container
      const childIdx = props.path[props.path.length - 1]
      const isFirst = childIdx === 0
      const isLast = childIdx === container.children.length - 1

      if (container.direction === "horizontal") {
        const directions = isFirst ? (["left", "right"] as Direction[]) : (["right"] as Direction[])
        const buttons = (!isLast ? ["right"] : []) as Direction[]
        return { directions, buttons }
      } else {
        const directions = isFirst ? (["top", "bottom"] as Direction[]) : (["bottom"] as Direction[])
        const buttons = (!isLast ? ["bottom"] : []) as Direction[]
        return { directions, buttons }
      }
    } catch {
      return empty
    }
  })

  return (
    <Switch>
      <Match when={props.layout?.type === "container" && props.layout}>
        {layout => (
          <Frame
            handleDirections={handles().directions}
            buttonDirections={handles().buttons}
            style={{ "flex-direction": layout().direction === "horizontal" ? "row" : "column" }}
            onAddFrame={direction =>
              context.mode() === "append"
                ? props.onAppend(props.path, direction)
                : props.onSplit(props.path, direction)
            }
            class={styles.container}
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
            handleDirections={handles().directions}
            buttonDirections={handles().buttons}
            onAddFrame={direction =>
              context.mode() === "append"
                ? props.onAppend(props.path, direction)
                : props.onSplit(props.path, direction)
            }
            onClick={() => {
              const m = context.mode()
              if (m === "append") {
                if (isNodeActive(props.path, { ...context.selection, depth: 0 })) {
                  // This entity is the leaf of current selection — cycle containers only (skip depth 0)
                  context.setSelection(s => ({
                    ...s,
                    depth: (s.depth % s.path.length) + 1,
                  }))
                } else {
                  // New entity tapped — immediately target parent container
                  context.setSelection(() => ({ path: props.path, depth: 1 }))
                }
              } else {
                // Split mode: original behavior, can select entity at depth 0
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

export function App() {
  const [layout, setLayout] = createStore<Container>({
    type: "container",
    direction: "horizontal",
    children: [createEntity()],
  })

  const [selection, setSelection] = createStore<{ path: Array<number>; depth: number }>({
    path: [0],
    depth: 0,
  })

  const [mode, setMode] = createSignal<Mode>("append")
  const [view, setView] = createSignal<View>("recording")
  const [bottomBarEl, setBottomBarEl] = createSignal<HTMLElement | undefined>()

  function appendToContainer(containerPath: number[], insertIndex: number) {
    const newEntity = createEntity()
    setLayout(proxy => {
      const container = resolveNode(proxy, containerPath) as Container
      container.children.splice(insertIndex, 0, newEntity)
    })
    setSelection(() => ({ path: [...containerPath, insertIndex], depth: 0 }))
  }

  function splitNode(nodePath: number[], direction: "top" | "bottom" | "left" | "right") {
    const splitDir: "horizontal" | "vertical" =
      direction === "left" || direction === "right" ? "horizontal" : "vertical"
    const newEntityFirst = direction === "top" || direction === "left"
    const newEntityIndex = newEntityFirst ? 0 : 1
    const newEntity = createEntity()

    if (nodePath.length === 0) {
      // Root has no parent — restructure root itself:
      // wrap existing children in an inner container, then set root to the split direction
      const inner: Container = {
        type: "container",
        direction: layout.direction,
        children: layout.children.map(cloneNode) as (Entity | Container)[],
      }
      setLayout(proxy => {
        proxy.direction = splitDir
        proxy.children.splice(
          0,
          proxy.children.length,
          ...(newEntityFirst ? [newEntity, inner] : [inner, newEntity]),
        )
      })
      setSelection(() => ({ path: [newEntityIndex], depth: 0 }))
      return
    }

    const node = resolveNode(layout, nodePath)
    const newContainer: Container = {
      type: "container",
      direction: splitDir,
      children: newEntityFirst ? [newEntity, cloneNode(node)] : [cloneNode(node), newEntity],
    }
    const parentPath = nodePath.slice(0, -1)
    const nodeIndex = nodePath[nodePath.length - 1]
    setLayout(proxy => {
      const parent = resolveNode(proxy, parentPath) as Container
      parent.children.splice(nodeIndex, 1, newContainer)
    })
    setSelection(() => ({ path: [...nodePath, newEntityIndex], depth: 0 }))
  }

  function handleAppend(path: number[], direction: Direction) {
    const containerPath = path.slice(0, -1)
    const childIndex = path[path.length - 1]
    const insertAfter = direction === "right" || direction === "bottom"
    appendToContainer(containerPath, insertAfter ? childIndex + 1 : childIndex)
  }

  return (
    <Context value={{ layout, selection, setSelection, mode, setMode, view, bottomBarEl, setBottomBarEl }}>
      <div style={{ display: "flex", width: "100vw", height: "100%" }}>
        <Show when={view() === "recording"}>
          <div class={styles.recordingView}>
            <NodeComponent layout={layout} path={[]} onAppend={handleAppend} onSplit={splitNode} />
            <Notch class={styles.recordingBar}>
              <div class={styles.recordingBarContent}>
                <button class={styles.barButton} onClick={() => setView("layout-builder")}>
                  <svg width="35" height="35" viewBox="0 0 35 35" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M33 19L19.5 19L19.5 33C19.5 34.1046 18.6046 35 17.5 35C16.3954 35 15.5 34.1046 15.5 33L15.5 19L2 19C0.895431 19 -8.69891e-07 18.1046 -8.16818e-07 17C-7.63746e-07 15.8954 0.895431 15 2 15L15.5 15L15.5 2C15.5 0.89543 16.3954 -7.39833e-07 17.5 -6.95908e-07C18.6046 -6.51984e-07 19.5 0.89543 19.5 2L19.5 15L33 15C34.1046 15 35 15.8954 35 17C35 18.1046 34.1046 19 33 19Z" fill="#D3D3D3"/>
                  </svg>
                </button>
                <button class={styles.barButton}>
                  <RecordIcon />
                </button>
                <button class={styles.barButton}>
                  <PlayIcon />
                </button>
              </div>
            </Notch>
          </div>
        </Show>
        <Show when={view() === "layout-builder"}>
          <LayoutBuilder onDone={() => setView("recording")}>
            <NodeComponent layout={layout} path={[]} onAppend={handleAppend} onSplit={splitNode} />
          </LayoutBuilder>
        </Show>
      </div>
    </Context>
  )
}
