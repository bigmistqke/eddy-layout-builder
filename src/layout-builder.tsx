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
import { MiniNode } from "./breadcrumb-minimap"
import { Context } from "./context"
import { ContextualToolbar } from "./contextual-toolbar"
import { Notch } from "./frame"
import styles from "./layout-builder.module.css"
import type { Node } from "./types"
import {
  computeViewportTransform,
  IDENTITY_VIEWPORT,
  selectedPathKey,
  transformToCss,
} from "./viewport"

export function Breadcrumb(props: { canvasAspect: Accessor<number> }) {
  const context = useContext(Context)!

  // Signal-driven collidable registration: ref just sets the signal, this
  // effect owns the lifecycle.
  createEffect(context.breadcrumbEl, el => {
    if (!el) return
    return context.registerCollidable(el, "hud")
  })

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
              onClick={() => context.setSelection(s => ({ ...s, depth: seg().depth }))}
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
  function recomputeViewport() {
    if (untrack(() => context.isAnimating())) return
    if (!innerEl || !canvasEl) return
    const rect = canvasEl.getBoundingClientRect()
    const baseW = rect.width
    const baseH = rect.height

    const key = untrack(() => selectedPathKey(context.selection))
    // Empty key = no selection (back button cleared it). Reset to identity.
    if (key === "") {
      setViewport({ ...IDENTITY_VIEWPORT, baseW, baseH })
      return
    }
    const node = innerEl.querySelector<HTMLElement>(`[data-path="${key}"]`)
    if (!node) return

    // Always fit the new selection. The viewport signal's `equals` is
    // epsilon-based — identity→identity is a no-op, sub-pixel drift from
    // recomputing against settled geometry is also a no-op, but a real
    // change (different selection, real resize) does propagate.
    const prev = untrack(() => viewport())
    const t = computeViewportTransform(node, innerEl, baseW, baseH, prev.scale)
    setViewport({ ...t, baseW, baseH })
  }

  onSettled(() => {
    if (!canvasEl) return
    context.setCanvasEl(canvasEl)
    // Seed baseW/baseH so the first render has explicit pixel dimensions
    // on canvasInner — required for width/height transitions to animate
    // (browsers won't interpolate between auto and a pixel value).
    const rect = canvasEl.getBoundingClientRect()
    setViewport(v => ({ ...v, baseW: rect.width, baseH: rect.height }))
    setCanvasAspect(rect.height > 0 ? rect.width / rect.height : 1)
    return context.observeFrame(canvasEl, () => {
      const r = canvasEl.getBoundingClientRect()
      if (r.height > 0) setCanvasAspect(r.width / r.height)
      recomputeViewport()
    })
  })

  // Selection changes drive viewport recomputes via this effect.
  createEffect(
    () => selectedPathKey(context.selection),
    () => recomputeViewport(),
  )

  // Expose "is the canvas currently zoomed" so the contextual back button
  // can hide itself when there is nothing to zoom out of. Wrapped in a block
  // so the setter's return value isn't treated as a cleanup function.
  createEffect(
    () => viewport().scale > 1,
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
      recomputeViewport()
      // Ask each frame to refresh its handle/HUD collision state now that
      // the canvas has settled.
      context.requestCollisionUpdate()
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
      <div class={styles.canvas} ref={canvasEl}>
        <div
          class={styles.canvasInner}
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
