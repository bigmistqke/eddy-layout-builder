import {
  Accessor,
  ComponentProps,
  createEffect,
  createMemo,
  createSignal,
  For,
  onSettled,
  untrack,
  useContext,
} from "solid-js"
import { logAction } from "./actions-log"
import { MiniNode } from "./breadcrumb-minimap"
import { Context } from "./context"
import { ContextualToolbar } from "./contextual-toolbar"
import { Notch } from "./frame"
import styles from "./layout-builder.module.css"
import type { Container, Node, Selection } from "./types"
import {
  applyTransform,
  computeExtends,
  computeSticks,
  computeViewportTransform,
  frameRect,
  IDENTITY_VIEWPORT,
  transformToCss,
  type Rect,
} from "./viewport"

/** Produce a string signature of the layout tree + selection. Reading this
 *  in a createEffect compute makes the effect re-fire whenever any
 *  container's children list, any container's direction, or the selection
 *  path/depth changes. */
function layoutSignature(layout: Container, selection: Selection): string {
  function nodeSignature(node: Node): string {
    if (node.type === "entity") return "e"
    return `${node.direction[0]}(${node.children.map(nodeSignature).join(",")})`
  }
  return `${nodeSignature(layout)}|${selection.path.join(".")}/${selection.depth}`
}

export function Breadcrumb(props: { canvasAspect: Accessor<number> }) {
  const context = useContext(Context)!

  // Each segment carries the highlight path from the layout root to the
  // node-in-scope at that segment's depth. `depth` is the value
  // `selection.depth` should take when this segment is tapped.
  const segments = createMemo(() => {
    const { path } = context.selection
    const segs: Array<{ highlightPath: number[]; depth: number }> = []

    // Segment 0: root scope — empty highlight path means "this node (root)
    // is highlighted." Visually the entire minimap is outlined.
    segs.push({ highlightPath: [], depth: path.length })

    let current: Node = context.app.layout
    for (let i = 0; i < path.length; i++) {
      if (current.type !== "container") break
      current = current.children[path[i]]
      const depth = path.length - 1 - i
      segs.push({ highlightPath: path.slice(0, i + 1), depth })
    }

    return segs
  })

  // Segment dimensions: fixed height, width = height * canvas aspect, capped.
  const SEGMENT_HEIGHT = 36
  const MAX_SEGMENT_WIDTH = 80
  const segmentSize = () => {
    const w = SEGMENT_HEIGHT * props.canvasAspect()
    return {
      height: `${SEGMENT_HEIGHT}`,
      width: `${MAX_SEGMENT_WIDTH}`,
    }
  }

  return (
    <Notch ref={context.setBreadcrumbEl} class={styles.breadcrumbNotch} orientation="top">
      <div class={styles.breadcrumbContent}>
        <For each={segments()}>
          {(seg, i) => (
            <button
              class={[
                styles.minimapButton,
                seg().depth === context.selection.depth ? styles.active : "",
              ].join(" ")}
              style={{
                "aspect-ratio": props.canvasAspect(),
              }}
              onClick={() => {
                logAction("tap-breadcrumb", { depth: seg().depth, segmentIndex: i() })
                context.setSelection(s => ({ ...s, depth: seg().depth }))
              }}
            >
              <MiniNode node={context.app.layout} highlightPath={seg().highlightPath} />
            </button>
          )}
        </For>
      </div>
    </Notch>
  )
}

type ViewportState = ReturnType<typeof computeViewportTransform> & {
  // canvas viewport dimensions captured at the time of computation —
  // used to size canvasInner explicitly when zoomed.
  baseW: number
  baseH: number
}

const INITIAL_VIEWPORT: ViewportState = { ...IDENTITY_VIEWPORT, baseW: 0, baseH: 0 }

export function LayoutBuilder(props: { children: ComponentProps<"div">["children"] }) {
  const context = useContext(Context)!
  let canvasEl!: HTMLDivElement
  let innerEl!: HTMLDivElement
  // ownedWrite: signals can be written from the effect callback below
  // (which runs in unowned scope per @solidjs/signals, but this is a defensive
  // opt-in in case any caller path is owned).
  // equals: short-circuits no-op updates so re-running the effect with an
  // identical viewport doesn't trigger a JSX re-render or CSS transition.
  // Uses epsilon comparison because computeViewportTransform can produce
  // sub-pixel floating-point drift between calls — without this, a recompute
  // post-animation would be flagged as "changed" and start a new animation.
  const eq = (a: number, b: number, eps = 0.5) => Math.abs(a - b) < eps
  // Canvas aspect ratio (width / height) — driven by the canvas ResizeObserver
  // and consumed by Breadcrumb to size minimap segments. Defaults to 1 until
  // the first measurement; the breadcrumb briefly renders square segments and
  // snaps once the observer fires.
  const [canvasAspect, setCanvasAspect] = createSignal(1, { ownedWrite: true })
  const [viewport, setViewport] = createSignal<ViewportState>(INITIAL_VIEWPORT, {
    ownedWrite: true,
    equals: (a, b) =>
      eq(a.scale, b.scale, 0.001) &&
      eq(a.x, b.x) &&
      eq(a.y, b.y) &&
      eq(a.baseW, b.baseW) &&
      eq(a.baseH, b.baseH),
  })
  // Imperative recompute: called from the selection-change effect, the
  // canvas-resize observer, and the post-animation settle. Short-circuits
  // while the canvas is mid-transition (ResizeObserver fires repeatedly as
  // canvasInner's width/height interpolate, and any setViewport call here
  // would retarget the CSS transition mid-flight).
  // Read each HUD's bounding rect in canvas-relative coords, skipping
  // detached refs. HUDs are partial-edge rectangles (corners, center
  // strips), not full-edge insets — model them as rects so per-handle
  // overlap detection can be precise.
  function computeHudRects(canvasRect: DOMRect): Rect[] {
    const hudEls = [
      untrack(() => context.breadcrumbEl()),
      untrack(() => context.bottomBarEl()),
      untrack(() => context.contextualToolbarEl()),
    ]
    const out: Rect[] = []
    for (const el of hudEls) {
      if (!el?.isConnected) continue
      const r = el.getBoundingClientRect()
      out.push({
        x: r.left - canvasRect.left,
        y: r.top - canvasRect.top,
        w: r.width,
        h: r.height,
      })
    }
    return out
  }

  function layoutPass() {
    if (untrack(() => context.isAnimating())) return
    if (!canvasEl) return
    const canvasRect = canvasEl.getBoundingClientRect()
    const canvas = { w: canvasRect.width, h: canvasRect.height }

    // Read selection inside untrack — layoutPass is the createEffect
    // callback (non-tracking by default in Solid 2.x), but the store-proxy
    // reads still warn STRICT_READ_UNTRACKED. Re-firing is driven by the
    // compute via layoutSignature, so untrack is correct here.
    const sel = untrack(() => ({
      path: context.selection.path.slice(),
      depth: context.selection.depth,
    }))
    // Cleared selection (back button) — reset everything.
    if (sel.path.length === 0) {
      setViewport({ ...IDENTITY_VIEWPORT, baseW: canvas.w, baseH: canvas.h })
      context.setSelectedHandlesState({
        extend: { top: 0, bottom: 0, left: 0, right: 0 },
        stick: { top: 0, bottom: 0, left: 0, right: 0 },
      })
      return
    }

    const len = sel.path.length - sel.depth
    const selectedPath = sel.path.slice(0, Math.max(0, len))
    const baseRect = untrack(() => frameRect(context.app.layout, selectedPath, canvas))

    const hudRects = computeHudRects(canvasRect)
    const transform = computeViewportTransform(baseRect, canvas, 1, hudRects)

    const postRect = applyTransform(baseRect, transform.scale, {
      x: transform.x,
      y: transform.y,
    })
    const extend = computeExtends(postRect, hudRects)
    const stick = computeSticks(postRect, canvas)

    setViewport({ ...transform, baseW: canvas.w, baseH: canvas.h })
    context.setSelectedHandlesState({ extend, stick })
  }

  onSettled(() => {
    if (!canvasEl) return
    // Seed baseW/baseH so the first render has explicit pixel dimensions
    // on canvasInner — required for width/height transitions to animate
    // (browsers won't interpolate between auto and a pixel value).
    const rect = canvasEl.getBoundingClientRect()
    setViewport(v => ({ ...v, baseW: rect.width, baseH: rect.height }))
    setCanvasAspect(rect.height > 0 ? rect.width / rect.height : 1)
    const ro = new ResizeObserver(() => {
      const r = canvasEl.getBoundingClientRect()
      if (r.height > 0) setCanvasAspect(r.width / r.height)
      layoutPass()
    })
    ro.observe(canvasEl)
    return () => ro.disconnect()
  })

  // Selection or layout-topology change drives viewport recomputes.
  createEffect(
    () => layoutSignature(context.app.layout, context.selection),
    () => layoutPass(),
  )

  // Expose "is the canvas currently zoomed" so the contextual back button
  // can hide itself when there is nothing to zoom out of. Wrapped in a block
  // so the setter's return value isn't treated as a cleanup function.
  createEffect(
    () => {
      const v = viewport()
      // Any non-identity transform — including pan-only (scale=1, x or y != 0).
      return v.scale > 1 || Math.abs(v.x) > 0.5 || Math.abs(v.y) > 0.5
    },
    zoomed => {
      context.setIsCanvasZoomed(zoomed)
    },
  )

  // Whenever the viewport changes (zoom in, zoom out via back, pan), the
  // canvas resizes underneath and frames may now have new handle/HUD
  // overlaps. Request a synchronous collision recheck so each frame re-runs
  // checkAllHandles against the current rendered geometry.
  //
  // Also flag isAnimating for the duration of the CSS transition so frames
  // hide their handles while the canvas is mid-flight. Otherwise the
  // ResizeObserver fires several times during the animation and toggles
  // handle visibility, which the user perceives as the animation getting
  // stuck partway through.
  let animationTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(viewport, () => {
    context.setIsAnimating(true)
    if (animationTimer) clearTimeout(animationTimer)
    animationTimer = setTimeout(() => {
      context.setIsAnimating(false)
      // Recompute against settled geometry — picks up any window resize
      // that happened during the animation. Epsilon equals on the viewport
      // signal short-circuits the no-drift case so a stable result doesn't
      // kick a new animation.
      layoutPass()
    }, 240) // 220ms transition + 20ms buffer
  })

  // Always set explicit pixel width/height so CSS transitions can animate
  // them (browsers don't interpolate between auto and a pixel value). At
  // scale = 1 this evaluates to `${baseW}px` / `${baseH}px`, which matches
  // the parent — no visual difference vs. inset: 0.
  const sizing = () => {
    const v = viewport()
    if (v.baseW === 0 || v.baseH === 0) return { width: undefined, height: undefined }
    return {
      width: `${v.baseW * v.scale}px`,
      height: `${v.baseH * v.scale}px`,
    }
  }

  return (
    <div class={styles.layoutBuilder}>
      <div class={styles.canvas} ref={canvasEl} data-canvas="true">
        <div
          class={styles.canvasInner}
          data-canvas-inner="true"
          ref={innerEl}
          style={{
            transform: transformToCss(viewport()),
            width: sizing().width,
            height: sizing().height,
          }}
        >
          {props.children}
        </div>
        <Breadcrumb canvasAspect={canvasAspect} />
        <ContextualToolbar />
      </div>
    </div>
  )
}
