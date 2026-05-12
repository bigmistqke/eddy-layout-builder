import { createEffect, createMemo, createSignal, createStore, untrack } from "solid-js"
import { createClipStore } from "./clips/store"
import { createPreview } from "./clips/preview"
import { createTransport } from "./clips/transport"
import { createProjectsStore } from "./state/projects"
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
import { createEntity, resolveNode } from "./utils"
import type { Rect, ViewportTransform } from "./viewport"

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
    // Start with the root entity selected AND preview active so the
    // camera lands in that cell immediately on page load.
    selection: { path: [], depth: 0, preview: true },
  })

  // HUD element refs — kept internal. Consumers register a ref via
  // setHudElement(kind) and read overlap rects via computeHudRects.
  const hudSignals: Record<HudKind, ReturnType<typeof createSignal<HTMLElement | undefined>>> = {
    main: createSignal<HTMLElement | undefined>(),
    breadcrumb: createSignal<HTMLElement | undefined>(),
    contextual: createSignal<HTMLElement | undefined>(),
    audio: createSignal<HTMLElement | undefined>(),
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
      untrack(hudSignals.audio[0]),
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
  const [viewport, setViewport] = createSignal<ViewportTransform>(
    { x: 0, y: 0, scale: 1 },
    { ownedWrite: true },
  )
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
    setSelection({ path: [...containerPath, insertIndex], depth: 0, preview: true })
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
        app.selection = { path: [newEntityIndex], depth: 0, preview: true }
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
        app.selection = { path: [...parentPath, newEntityIndex], depth: 0, preview: true }
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
    setSelection({ path: [...nodePath, newEntityIndex], depth: 0, preview: true })
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

    // Collect entity ids in the subtree being removed so we can drop
    // their clips after the layout mutation.
    const removedIds: string[] = []
    function collectIds(node: Node) {
      if (node.type === "entity") {
        removedIds.push(node.id)
        return
      }
      for (const child of node.children) {
        collectIds(child)
      }
    }
    const targetNode = resolveNode(app.layout, targetedPath)
    collectIds(targetNode)

    // Always select the parent's path after delete:
    //   * Parent with ≥2 remaining children: parent stays a container,
    //     parentPath still points to it.
    //   * Parent collapses (had 2 children → 1 left): the surviving
    //     sibling takes parentPath's slot, so parentPath now points to
    //     that sibling. Either way selecting parentPath is correct.
    //   * Root targetedPath ([]): root is replaced with a fresh entity;
    //     selecting [] focuses the new entity.
    const parentPath = targetedPath.slice(0, -1)
    const nextSelection: Selection = { path: parentPath, depth: 0, preview: true }

    setApp(app => {
      const next = removeAt(app.layout, targetedPath)
      app.layout = next ?? createEntity()
      app.selection = nextSelection
    })

    for (const cellId of removedIds) {
      clips.clearClip(cellId)
      void projects.removeClipBlob(cellId)
    }
    if (Object.keys(clips.clips).length === 0) {
      setSongLength(null)
    }
  }

  function setTool(tool: Tool) {
    setApp(app => {
      app.tool = tool
    })
    // Selection persists across tool changes. The viewport identity
    // reset on tool→null is handled by recomputeViewport in canvas.tsx
    // (which returns identity when tool === null). Keeping selection
    // lets song-mode features (record, preview) inherit whatever cell
    // the user was last focused on.
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

  const clips = createClipStore()
  const transport = createTransport()
  const preview = createPreview()
  const [songLength, setSongLength] = createSignal<number | null>(null)

  const projects = createProjectsStore({
    clips,
    setLayout(layout) {
      setApp(app => {
        app.layout = layout
      })
    },
    setSongLength,
    resetSelection() {
      // Match the boot state: root selected with preview active so the
      // camera lands in the (new) root cell.
      setApp(app => {
        app.selection = { path: [], depth: 0, preview: true }
      })
    },
    readLayout: () => untrack(() => app.layout),
    readSongLength: () => untrack(songLength),
  })

  // Single auto-save effect: any change to layout, songLength, or the
  // set of recorded cells writes a fresh manifest. Skipped while a
  // load is in flight so we don't redundantly re-save state we just
  // pulled from disk.
  createEffect(
    () => ({
      layout: app.layout,
      songLength: songLength(),
      cellIds: clips.cellIds().join("|"),
      cellVolumes: clips.cellVolumes(),
      loading: projects.isLoading(),
    }),
    ({ loading }) => {
      if (loading) {
        return
      }
      void projects.saveCurrent()
    },
  )

  // Boot-time OPFS load. Fire-and-forget — UI starts with the initial
  // fresh-entity layout; if OPFS has saved state, init() swaps it in
  // shortly after mount.
  void projects.init()

  // The cell that the live camera preview should paint into — derived,
  // not stored. A previewing selection lands the camera on its cell in
  // both song mode AND tool mode (splitting/appending is usually the
  // setup for "I want to record into this newly-created cell"). The
  // post-record state (selection.preview === false) yields null so
  // the cell shows its clip's frame 0 instead.
  const previewTargetCellId = createMemo<string | null>(() => {
    const selection = app.selection
    if (selection === null || !selection.preview) {
      return null
    }
    const targetedPath = selection.path.slice(0, selection.path.length - selection.depth)
    const node = resolveNode(app.layout, targetedPath)
    return node.type === "entity" ? node.id : null
  })

  // Mute the previewed cell's clip audio so the live camera in that
  // cell isn't doubled up with its own recording. The transport keeps
  // the source scheduled (gain=0); unmuting resumes in sample-lock
  // with the rest of the song.
  createEffect(previewTargetCellId, cellId => {
    transport.setMutedCell(cellId)
  })

  // Push per-cell volume changes (from the audio-tool slider, or from
  // a project load via clipStore.setCellVolumes) into the transport's
  // existing per-cell GainNode. effective gain = muted ? 0 : volume.
  createEffect(clips.cellVolumes, volumes => {
    for (const cellId of Object.keys(volumes)) {
      transport.setCellVolume(cellId, volumes[cellId])
    }
  })

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
    viewport,
    setViewport,
    clips,
    transport,
    preview,
    projects,
    songLength,
    setSongLength,
    previewTargetCellId,
  }
}
