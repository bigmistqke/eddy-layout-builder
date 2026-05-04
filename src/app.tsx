import type { StoreSetter } from "@solidjs/signals"
import { omit } from "@solidjs/signals"
import {
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
import { Frame } from "./frame"
import { LayoutBuilder } from "./layout-builder"
import type { Container, Entity, Mode, Node, View } from "./types"

type Selection = { path: Array<number>; depth: number }

export const Context = createContext<{
  layout: Container
  selection: Selection
  setSelection: StoreSetter<Selection>
  mode: () => Mode
  setMode: (mode: Mode) => void
  view: () => View
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

function NodeComponent(props: {
  layout: Node
  onAddFrame(path: number[], direction: "top" | "bottom" | "left" | "right"): void
  path: Array<number>
}) {
  const context = useContext(Context)!

  const handleDirections = createMemo(() => {
    if (context.view() !== "layout-builder") return []
    const s = context.selection
    const m = context.mode()
    const targetedPath = s.path.slice(0, s.path.length - s.depth)

    if (m === "split") {
      if (!pathEquals(props.path, targetedPath)) return []
      return ["top", "bottom", "left", "right"] as ("top" | "bottom" | "left" | "right")[]
    }

    // Append mode: find the container whose handles to show
    try {
      const targeted = resolveNode(context.layout, targetedPath)
      const containerPath =
        targeted.type === "container" ? targetedPath : targetedPath.slice(0, -1)
      if (!pathEquals(props.path, containerPath)) return []
      const container = (
        targeted.type === "container" ? targeted : resolveNode(context.layout, containerPath)
      ) as Container
      return container.direction === "horizontal"
        ? (["left", "right"] as ("top" | "bottom" | "left" | "right")[])
        : (["top", "bottom"] as ("top" | "bottom" | "left" | "right")[])
    } catch {
      return []
    }
  })

  return (
    <Switch>
      <Match when={props.layout?.type === "container" && props.layout}>
        {layout => (
          <Frame
            handleDirections={handleDirections()}
            style={{ "flex-direction": layout().direction === "horizontal" ? "row" : "column" }}
            onAddFrame={direction => props.onAddFrame(props.path, direction)}
            class={styles.container}
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
            handleDirections={handleDirections()}
            onAddFrame={direction => props.onAddFrame(props.path, direction)}
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

  function appendToContainer(containerPath: number[], insertAtStart: boolean) {
    const newEntity = createEntity()
    const newIndex = insertAtStart
      ? 0
      : (resolveNode(layout, containerPath) as Container).children.length
    setLayout(proxy => {
      const container = resolveNode(proxy, containerPath) as Container
      if (insertAtStart) {
        container.children.unshift(newEntity)
      } else {
        container.children.push(newEntity)
      }
    })
    setSelection(() => ({ path: [...containerPath, newIndex], depth: 0 }))
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
        proxy.children.splice(0, proxy.children.length, ...(newEntityFirst ? [newEntity, inner] : [inner, newEntity]))
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

  function handleAddFrame(path: number[], direction: "top" | "bottom" | "left" | "right") {
    if (mode() === "append") {
      appendToContainer(path, direction === "top" || direction === "left")
    } else {
      splitNode(path, direction)
    }
  }

  return (
    <Context value={{ layout, selection, setSelection, mode, setMode, view }}>
      <div style={{ display: "flex", width: "100vw", height: "100%" }}>
        <Show when={view() === "recording"}>
          <div class={styles.recordingView}>
            <NodeComponent layout={layout} path={[]} onAddFrame={handleAddFrame} />
            <button class={styles.addButton} onClick={() => setView("layout-builder")}>
              +
            </button>
          </div>
        </Show>
        <Show when={view() === "layout-builder"}>
          <LayoutBuilder onDone={() => setView("recording")}>
            <NodeComponent layout={layout} path={[]} onAddFrame={handleAddFrame} />
          </LayoutBuilder>
        </Show>
      </div>
    </Context>
  )
}
