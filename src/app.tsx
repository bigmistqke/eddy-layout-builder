import {
  createEffect,
  createSignal,
  createStore,
  getOwner,
  Match,
  onCleanup,
  runWithOwner,
  Show,
  Switch,
} from "solid-js"
import styles from "./app.module.css"
import type { Collidable, CollisionHit, CollisionKind } from "./collision"
import { rectsOverlap } from "./collision"
import { Context } from "./context"
import { Notch } from "./frame"
import { CloseIcon, PlayIcon, PlusIcon, RecordIcon, SplitIcon } from "./icons"
import { LayoutBuilder } from "./layout-builder"
import { NodeComponent } from "./node-component"
import type { AppState, Container, Direction, Entity, Node } from "./types"
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
  const owner = getOwner()
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

  const frameCallbacks = new Set<() => void>()
  const controller = new AbortController()
  const resizeObserver = new ResizeObserver(() => frameCallbacks.forEach(cb => cb()))
  window.addEventListener("resize", () => frameCallbacks.forEach(cb => cb()), controller)

  onCleanup(() => {
    resizeObserver.disconnect()
    controller.abort()
  })

  function observeFrame(el: HTMLElement, cb: () => void) {
    frameCallbacks.add(cb)
    resizeObserver.observe(el)
    return () => {
      frameCallbacks.delete(cb)
      resizeObserver.unobserve(el)
    }
  }

  const collidables = new Set<Collidable>()
  // Bumped on every register/unregister so consumers can re-run their
  // collision checks whenever the registry changes.
  const [collisionVersion, setCollisionVersion] = createSignal(0)

  function registerCollidable(el: HTMLElement, kind: CollisionKind) {
    const entry: Collidable = { el, kind }
    collidables.add(entry)
    setCollisionVersion(v => v + 1)
    return () => {
      collidables.delete(entry)
      setCollisionVersion(v => v + 1)
    }
  }

  function findCollisions(el: HTMLElement): CollisionHit[] {
    const target = el.getBoundingClientRect()
    const hits: CollisionHit[] = []
    for (const c of collidables) {
      if (c.el === el) continue
      const rect = c.el.getBoundingClientRect()
      if (rectsOverlap(target, rect)) hits.push({ el: c.el, kind: c.kind, rect })
    }
    return hits
  }

  function appendToContainer(containerPath: number[], insertIndex: number) {
    const newEntity = createEntity()
    setApp(proxy => {
      const container = resolveNode(proxy.layout, containerPath) as Container
      container.children.splice(insertIndex, 0, newEntity)
    })
    setSelection(() => ({ path: [...containerPath, insertIndex], depth: 1 }))
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
    if (selection.depth === 0) setSelection(s => ({ ...s, depth: 1 }))
  }

  const layoutView = () =>
    app.view.type === "layout" ? (app.view as { type: "layout"; mode: "append" | "split" }) : null

  createEffect(bottomBarEl, bar => {
    if (!bar) return
    resizeObserver.observe(bar)
    return () => {
      resizeObserver.unobserve(bar)
    }
  })

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
        observeFrame,
        registerCollidable,
        findCollisions,
        collisionVersion,
        isCanvasZoomed,
        setIsCanvasZoomed,
      }}
    >
      <div style={{ display: "flex", width: "100vw", height: "100%", position: "relative" }}>
        <Show when={app.view.type === "recording"}>
          <div class={styles.recordingView}>
            <NodeComponent
              layout={app.layout}
              path={[]}
              onAppend={handleAppend}
              onSplit={splitNode}
            />
          </div>
        </Show>
        <Show when={app.view.type === "layout"}>
          <LayoutBuilder>
            <NodeComponent
              layout={app.layout}
              path={[]}
              onAppend={handleAppend}
              onSplit={splitNode}
            />
          </LayoutBuilder>
        </Show>
        <Notch
          ref={el => {
            setBottomBarEl(el)
            // Register OUTSIDE runWithOwner — registerCollidable bumps a signal,
            // and signal writes are forbidden in owned reactive scopes. The
            // ref callback itself runs unowned (per @solidjs/web ref()), so
            // it's the right place to write. Only re-enter the component
            // owner to attach onCleanup, which is just a registration call.
            const unregister = registerCollidable(el, "hud")
            runWithOwner(owner, () => onCleanup(unregister))
          }}
          class={styles.bottomBar}
        >
          <div class={styles.bottomBarContent}>
            <Switch>
              <Match when={app.view.type === "recording"}>
                <button class={styles.barButton} onClick={() => enterAppendMode()}>
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
                  onClick={() => enterAppendMode()}
                >
                  <PlusIcon />
                </button>
                <button
                  class={[styles.modeButton, layoutView()?.mode === "split" ? styles.active : ""]}
                  onClick={() => {
                    setApp(app => {
                      app.view = { type: "layout", mode: "split" }
                    })
                  }}
                >
                  <SplitIcon />
                </button>
                <button
                  class={styles.closeButton}
                  onClick={() => {
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
