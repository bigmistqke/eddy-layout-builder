import { createSignal, createStore, untrack } from "solid-js"
import type {
  AppContext,
  AppState,
  Container,
  Direction,
  Entity,
  HandleOp,
  HudKind,
  Node,
  SelectedHandlesState,
  Selection,
  Tool,
} from "./types"
import { resolveNode } from "./utils"
import type { Rect } from "./viewport"

function cloneNode(node: Node): Node {
  if (node.type === "entity") {
    return { ...node }
  }

  return { type: "container", direction: node.direction, children: node.children.map(cloneNode) }
}

/**
 * Remove the node at `path` from `node`. Returns the new tree, or
 * `null` if the entire node should be removed from its parent.
 *
 * Collapses on the way up: any container that ends up with a single
 * child is replaced by that child; any container with no children
 * returns `null` so its parent strips it as well. The caller decides
 * what to do with a `null` root (typically: spawn a fresh Entity).
 */
function removeAt(node: Node, path: number[]): Node | null {
  if (path.length === 0) {
    return null
  }
  if (node.type !== "container") {
    return node
  }
  const [head, ...rest] = path
  const child = node.children[head]
  if (!child) {
    return node
  }
  const replacement = rest.length === 0 ? null : removeAt(child, rest)
  const nextChildren: Array<Entity | Container> =
    replacement === null
      ? node.children.filter((_, index) => index !== head)
      : node.children.map((existing, index) =>
          index === head ? (replacement as Entity | Container) : existing,
        )
  if (nextChildren.length === 0) {
    return null
  }
  if (nextChildren.length === 1) {
    return nextChildren[0]
  }
  return { type: "container", direction: node.direction, children: nextChildren }
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
export function createAppState(): AppContext {
  const [app, setApp] = createStore<AppState>({
    layout: createEntity(),
    tool: null,
    selection: null,
  })

  // HUD element refs — kept internal. Consumers register a ref via
  // setHudElement(kind) and read overlap rects via computeHudRects.
  const hudSignals: Record<HudKind, ReturnType<typeof createSignal<HTMLElement | undefined>>> = {
    main: createSignal<HTMLElement | undefined>(),
    breadcrumb: createSignal<HTMLElement | undefined>(),
    contextual: createSignal<HTMLElement | undefined>(),
  }

  const setHudElement = (kind: HudKind) => hudSignals[kind][1]

  /**
   * Read each HUD's bounding rect in canvas-relative coords, skipping
   * detached refs. HUDs are partial-edge rectangles (corners, center
   * strips), not full-edge insets — model them as rects so per-handle
   * overlap detection can be precise.
   */
  function computeHudRects(canvasRect: DOMRect): Rect[] {
    const elements = [
      untrack(hudSignals.breadcrumb[0]),
      untrack(hudSignals.main[0]),
      untrack(hudSignals.contextual[0]),
    ]
    const rects: Rect[] = []
    for (const element of elements) {
      if (!element?.isConnected) {
        continue
      }
      const elementRect = element.getBoundingClientRect()
      rects.push({
        x: elementRect.left - canvasRect.left,
        y: elementRect.top - canvasRect.top,
        width: elementRect.width,
        height: elementRect.height,
      })
    }
    return rects
  }

  const [isCanvasZoomed, setIsCanvasZoomed] = createSignal(false)
  const [isAnimating, setIsAnimating] = createSignal(false, { ownedWrite: true })
  const [selectedHandlesState, setSelectedHandlesState] = createSignal<SelectedHandlesState>(
    { extend: ZERO_BY_DIR, stick: ZERO_BY_DIR },
    { ownedWrite: true },
  )

  function setSelection(next: Selection | null) {
    setApp(app => {
      app.selection = next
    })
  }

  function appendToContainer(containerPath: number[], insertIndex: number) {
    const newEntity = createEntity()
    setApp(app => {
      const container = resolveNode(app.layout, containerPath) as Container
      container.children.splice(insertIndex, 0, newEntity)
    })
    setSelection({ path: [...containerPath, insertIndex], depth: 0 })
  }

  function splitNode(nodePath: number[], direction: Direction) {
    const splitDirection: "horizontal" | "vertical" =
      direction === "left" || direction === "right" ? "horizontal" : "vertical"
    const newEntityFirst = direction === "top" || direction === "left"
    const newEntityIndex = newEntityFirst ? 0 : 1
    const newEntity = createEntity()

    if (nodePath.length === 0) {
      // Root may be an Entity (initial state, or after future delete
      // collapses the tree). Wrap it in a fresh container alongside the
      // new entity. If it's already a container, clone it and replace
      // root with [new, old] (or [old, new]) under the split direction.
      const oldRoot = app.layout
      const wrapped: Node =
        oldRoot.type === "entity"
          ? cloneNode(oldRoot)
          : {
              type: "container",
              direction: oldRoot.direction,
              children: oldRoot.children.map(cloneNode) as (Entity | Container)[],
            }
      const nextRoot: Container = {
        type: "container",
        direction: splitDirection,
        children: newEntityFirst ? [newEntity, wrapped] : [wrapped, newEntity],
      }
      setApp(app => {
        app.layout = nextRoot
      })
      setApp(app => {
        app.selection = { path: [newEntityIndex], depth: 0 }
      })

      return
    }

    const parentPath = nodePath.slice(0, -1)
    const nodeIndex = nodePath[nodePath.length - 1]
    const parent = resolveNode(app.layout, parentPath) as Container

    if (parent.children.length === 1) {
      setApp(app => {
        const parent = resolveNode(app.layout, parentPath) as Container
        parent.direction = splitDirection
        parent.children.splice(newEntityFirst ? 0 : 1, 0, newEntity)
      })
      setApp(app => {
        app.selection = { path: [...parentPath, newEntityIndex], depth: 0 }
      })

      return
    }

    const node = resolveNode(app.layout, nodePath)
    const newContainer: Container = {
      type: "container",
      direction: splitDirection,
      children: newEntityFirst ? [newEntity, cloneNode(node)] : [cloneNode(node), newEntity],
    }
    setApp(app => {
      const parent = resolveNode(app.layout, parentPath) as Container
      parent.children.splice(nodeIndex, 1, newContainer)
    })
    setSelection({ path: [...nodePath, newEntityIndex], depth: 0 })
  }

  function handleAppend(path: number[], direction: Direction) {
    const containerPath = path.slice(0, -1)
    const childIndex = path[path.length - 1]
    const insertAfter = direction === "right" || direction === "bottom"
    appendToContainer(containerPath, insertAfter ? childIndex + 1 : childIndex)
  }

  function deleteSelection() {
    const selection = app.selection
    if (selection === null) {
      return
    }
    // Delete the targeted node — the selection's `depth` collapses some
    // tail of `path`, so the actual target is path[..-depth].
    const targetedPath = selection.path.slice(0, selection.path.length - selection.depth)
    setApp(app => {
      const next = removeAt(app.layout, targetedPath)
      app.layout = next ?? createEntity()
      app.selection = null
    })
  }

  function setTool(tool: Tool) {
    setApp(app => {
      app.tool = tool
      // Toggling the tool off exits edit mode entirely — clear the
      // selection so the viewport zooms back to identity. Switching
      // between append and split keeps the selection intact.
      if (tool === null) {
        app.selection = null
      }
    })
  }

  function handleAddFrame(path: number[], direction: Direction, operation: HandleOp) {
    if (operation === "split") {
      splitNode(path, direction)
      return
    }
    // Root is an Entity — there's no parent to append to, so the only
    // valid append at path=[] is a wrap (delegate to splitNode).
    if (path.length === 0 && app.layout.type === "entity") {
      splitNode(path, direction)
      return
    }
    // operation === "append" — but if the requested direction is
    // perpendicular to the parent's flex axis, a sibling-insert is
    // meaningless. Wrap the entity instead (delegating to splitNode,
    // which already does this).
    const parentDirection: "horizontal" | "vertical" =
      path.length === 0
        ? (app.layout as Container).direction
        : (resolveNode(app.layout, path.slice(0, -1)) as Container).direction
    const directionAxis = direction === "left" || direction === "right" ? "horizontal" : "vertical"
    if (directionAxis !== parentDirection) {
      splitNode(path, direction)
      return
    }
    if (path.length === 0) {
      // Root: append a child to root itself (root is a Container here).
      const insertAfter = direction === "right" || direction === "bottom"
      appendToContainer([], insertAfter ? (app.layout as Container).children.length : 0)
      return
    }
    handleAppend(path, direction)
  }

  return {
    app,
    setSelection,
    setHudElement,
    computeHudRects,
    isCanvasZoomed,
    setIsCanvasZoomed,
    isAnimating,
    setIsAnimating,
    selectedHandlesState,
    setSelectedHandlesState,
    setTool,
    deleteSelection,
    handleAddFrame,
  }
}
