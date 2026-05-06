import { createSignal, createStore } from "solid-js"
import type {
  AppContext,
  AppState,
  Container,
  Direction,
  Entity,
  HandleOp,
  Node,
  SelectedHandlesState,
} from "./types"
import { resolveNode } from "./utils"

function cloneNode(node: Node): Node {
  if (node.type === "entity") return { ...node }
  return { type: "container", direction: node.direction, children: node.children.map(cloneNode) }
}

function createEntity(): Entity {
  return {
    type: "entity",
    color: `rgb(${Math.random() * 100 + 150}, ${Math.random() * 100 + 150}, ${Math.random() * 100 + 150})`,
  }
}

const ZERO_BY_DIR: Record<Direction, number> = { top: 0, bottom: 0, left: 0, right: 0 }

/**
 * Build the full app context — stores, signals, and mutation helpers.
 * Called once in App(); the returned object is passed straight into the
 * Context provider.
 */
export function createAppState(): AppContext & {
  enterAppendMode: () => void
  enterSplitMode: () => void
  exitLayout: () => void
  handleAddFrame: (path: number[], direction: Direction, op: HandleOp) => void
} {
  const [selection, setSelection] = createStore({ path: [0] as Array<number>, depth: 0 })
  const [app, setApp] = createStore<AppState>({
    view: { type: "recording" },
    layout: {
      type: "container",
      direction: "horizontal",
      children: [createEntity()],
    },
  })

  const [bottomBarEl, setBottomBarEl] = createSignal<HTMLElement | undefined>()
  const [breadcrumbEl, setBreadcrumbEl] = createSignal<HTMLElement | undefined>()
  const [contextualToolbarEl, setContextualToolbarEl] = createSignal<HTMLElement | undefined>()
  const [isCanvasZoomed, setIsCanvasZoomed] = createSignal(false)
  const [isAnimating, setIsAnimating] = createSignal(false, { ownedWrite: true })
  const [selectedHandlesState, setSelectedHandlesState] = createSignal<SelectedHandlesState>(
    { extend: ZERO_BY_DIR, stick: ZERO_BY_DIR },
    { ownedWrite: true },
  )

  function appendToContainer(containerPath: number[], insertIndex: number) {
    const newEntity = createEntity()
    setApp(proxy => {
      const container = resolveNode(proxy.layout, containerPath) as Container
      container.children.splice(insertIndex, 0, newEntity)
    })
    setSelection(() => ({ path: [...containerPath, insertIndex], depth: 0 }))
  }

  function splitNode(nodePath: number[], direction: Direction) {
    const splitDir: "horizontal" | "vertical" =
      direction === "left" || direction === "right" ? "horizontal" : "vertical"
    const newEntityFirst = direction === "top" || direction === "left"
    const newEntityIndex = newEntityFirst ? 0 : 1
    const newEntity = createEntity()

    if (nodePath.length === 0) {
      const inner: Container = {
        type: "container",
        direction: app.layout.direction,
        children: app.layout.children.map(cloneNode) as (Entity | Container)[],
      }
      setApp(proxy => {
        proxy.layout.direction = splitDir
        proxy.layout.children.splice(
          0,
          proxy.layout.children.length,
          ...(newEntityFirst ? [newEntity, inner] : [inner, newEntity]),
        )
      })
      setSelection(() => ({ path: [newEntityIndex], depth: 0 }))
      return
    }

    const parentPath = nodePath.slice(0, -1)
    const nodeIndex = nodePath[nodePath.length - 1]
    const parent = resolveNode(app.layout, parentPath) as Container

    if (parent.children.length === 1) {
      setApp(proxy => {
        const p = resolveNode(proxy.layout, parentPath) as Container
        p.direction = splitDir
        p.children.splice(newEntityFirst ? 0 : 1, 0, newEntity)
      })
      setSelection(() => ({ path: [...parentPath, newEntityIndex], depth: 0 }))
      return
    }

    const node = resolveNode(app.layout, nodePath)
    const newContainer: Container = {
      type: "container",
      direction: splitDir,
      children: newEntityFirst ? [newEntity, cloneNode(node)] : [cloneNode(node), newEntity],
    }
    setApp(proxy => {
      const p = resolveNode(proxy.layout, parentPath) as Container
      p.children.splice(nodeIndex, 1, newContainer)
    })
    setSelection(() => ({ path: [...nodePath, newEntityIndex], depth: 0 }))
  }

  function handleAppend(path: number[], direction: Direction) {
    const containerPath = path.slice(0, -1)
    const childIndex = path[path.length - 1]
    const insertAfter = direction === "right" || direction === "bottom"
    appendToContainer(containerPath, insertAfter ? childIndex + 1 : childIndex)
  }

  function enterAppendMode() {
    setApp(store => {
      store.view = { type: "layout", mode: "append" }
    })
  }

  function enterSplitMode() {
    setApp(store => {
      store.view = { type: "layout", mode: "split" }
    })
  }

  function exitLayout() {
    setApp(store => {
      store.view = { type: "recording" }
    })
  }

  function handleAddFrame(path: number[], direction: Direction, op: HandleOp) {
    if (op === "split") {
      splitNode(path, direction)
      return
    }
    // op === "append" — but if the requested direction is perpendicular to
    // the parent's flex axis, a sibling-insert is meaningless. Wrap the
    // entity instead (delegating to splitNode, which already does this).
    const parentDirection: "horizontal" | "vertical" =
      path.length === 0
        ? app.layout.direction
        : (resolveNode(app.layout, path.slice(0, -1)) as Container).direction
    const dirAxis = direction === "left" || direction === "right" ? "horizontal" : "vertical"
    if (dirAxis !== parentDirection) {
      splitNode(path, direction)
      return
    }
    if (path.length === 0) {
      // Root: append a child to root itself.
      const insertAfter = direction === "right" || direction === "bottom"
      appendToContainer([], insertAfter ? app.layout.children.length : 0)
      return
    }
    handleAppend(path, direction)
  }

  return {
    selection,
    setSelection,
    app,
    setApp,
    bottomBarEl,
    setBottomBarEl,
    breadcrumbEl,
    setBreadcrumbEl,
    contextualToolbarEl,
    setContextualToolbarEl,
    isCanvasZoomed,
    setIsCanvasZoomed,
    isAnimating,
    setIsAnimating,
    selectedHandlesState,
    setSelectedHandlesState,
    enterAppendMode,
    enterSplitMode,
    exitLayout,
    handleAddFrame,
  }
}
