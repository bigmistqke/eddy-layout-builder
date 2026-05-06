import { createSignal, createStore, Match, Show, Switch } from "solid-js"
import { logAction } from "./actions-log"
import styles from "./app.module.css"
import { Context } from "./context"
import { Notch } from "./frame"
import { CloseIcon, PlayIcon, PlusIcon, RecordIcon, SplitIcon } from "./icons"
import { LayoutBuilder } from "./layout-builder"
import { NodeComponent } from "./node-component"
import type { AppState, Container, Direction, Entity, HandleOp, Node, SelectedHandlesState } from "./types"
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

export function App() {
  const [selection, setSelection] = createStore({ path: [0] as Array<number>, depth: 0 })
  const [app, setApp] = createStore<AppState>({
    view: {
      type: "recording",
    },
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
  const ZERO_BY_DIR: Record<Direction, number> = { top: 0, bottom: 0, left: 0, right: 0 }
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
    // Parent-axis append.
    if (path.length === 0) {
      // Root: append a child to root itself.
      const insertAfter = direction === "right" || direction === "bottom"
      appendToContainer([], insertAfter ? app.layout.children.length : 0)
      return
    }
    handleAppend(path, direction)
  }

  const layoutView = () =>
    app.view.type === "layout" ? (app.view as { type: "layout"; mode: "append" | "split" }) : null

  return (
    <Context
      value={{
        selection,
        setSelection,
        app,
        setApp: setApp,
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
      }}
    >
      <div style={{ display: "flex", width: "100vw", height: "100%", position: "relative" }}>
        <Show when={app.view.type === "recording"}>
          <div class={styles.recordingView}>
            <NodeComponent
              layout={app.layout}
              path={[]}
              onAddFrame={handleAddFrame}
            />
          </div>
        </Show>
        <Show when={app.view.type === "layout"}>
          <LayoutBuilder>
            <NodeComponent
              layout={app.layout}
              path={[]}
              onAddFrame={handleAddFrame}
            />
          </LayoutBuilder>
        </Show>
        <Notch ref={setBottomBarEl} class={styles.bottomBar}>
          <div class={styles.bottomBarContent}>
            <Switch>
              <Match when={app.view.type === "recording"}>
                <button
                  class={styles.barButton}
                  data-action="enter-layout"
                  onClick={() => {
                    logAction("enter-layout")
                    enterAppendMode()
                  }}
                >
                  <PlusIcon />
                </button>
                <button class={styles.barButton}>
                  <RecordIcon />
                </button>
                <button class={styles.barButton}>
                  <PlayIcon />
                </button>
              </Match>
              <Match when={app.view.type === "layout"}>
                <button
                  class={[styles.modeButton, layoutView()?.mode === "append" ? styles.active : ""]}
                  data-action="set-mode-append"
                  onClick={() => {
                    logAction("set-mode", { mode: "append" })
                    enterAppendMode()
                  }}
                >
                  <PlusIcon />
                </button>
                <button
                  class={[styles.modeButton, layoutView()?.mode === "split" ? styles.active : ""]}
                  data-action="set-mode-split"
                  onClick={() => {
                    logAction("set-mode", { mode: "split" })
                    setApp(app => {
                      app.view = { type: "layout", mode: "split" }
                    })
                  }}
                >
                  <SplitIcon />
                </button>
                <button
                  class={styles.closeButton}
                  data-action="exit-layout"
                  onClick={() => {
                    logAction("exit-layout")
                    setApp(app => {
                      app.view = { type: "recording" }
                    })
                  }}
                >
                  <CloseIcon />
                </button>
              </Match>
            </Switch>
          </div>
        </Notch>
      </div>
    </Context>
  )
}
