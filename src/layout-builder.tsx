import {
  ComponentProps,
  createEffect,
  createSignal,
  onSettled,
  untrack,
  useContext,
} from "solid-js"
import { Context } from "./context"
import { Breadcrumb } from "./hud/breadcrumb"
import { Contextual } from "./hud/contextual"
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
    // Empty selection (back button cleared) is treated as "root scope" —
    // root frame still renders handles via NodeComponent.handles() because
    // its path matches the empty targetedPath. So compute handle state
    // for the root rect; computeViewportTransform returns identity for
    // any frame that fits naturally, so the canvas pan/zoom stays zero.
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

  // WAAPI-driven animation. Each viewport change captures the rendered
  // "from" state (so an animation interrupted mid-flight starts from where
  // it currently is, not from the prior settled state) and animates to the
  // new state. All three properties (transform, width, height) are
  // keyframes in a single Animation, so the easing curve's time fraction is
  // applied to all of them together — width can't fall behind transform
  // the way it can with separate CSS transitions.
  let currentAnim: Animation | undefined
  let animationTimer: ReturnType<typeof setTimeout> | undefined
  const ANIMATION_MS = 220
  const SETTLE_MS = ANIMATION_MS + 20

  createEffect(viewport, v => {
    if (!innerEl) return
    if (v.baseW === 0 || v.baseH === 0) return

    const toTransform = transformToCss(v)
    const toW = `${v.baseW * v.scale}px`
    const toH = `${v.baseH * v.scale}px`

    // Read the rendered "from" state. If a previous animation was running,
    // computedStyle reflects its current value (mid-interpolation), so the
    // new animation seamlessly continues from there.
    const cs = getComputedStyle(innerEl)
    const fromTransform = cs.transform === "none" ? "translate(0px, 0px)" : cs.transform
    const fromW = cs.width
    const fromH = cs.height

    // Cancel any in-flight animation; we're replacing it with a new one
    // that starts from where the canvas actually IS right now.
    currentAnim?.cancel()

    // Set the underlying inline style so post-animation the element rests
    // at the new state (fill: 'forwards' on the animation alone would also
    // work, but we want the underlying style to match for any consumer
    // reading style directly).
    innerEl.style.transform = toTransform
    innerEl.style.width = toW
    innerEl.style.height = toH

    currentAnim = innerEl.animate(
      [
        { transform: fromTransform, width: fromW, height: fromH },
        { transform: toTransform, width: toW, height: toH },
      ],
      { duration: ANIMATION_MS, easing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "none" },
    )

    context.setIsAnimating(true)
    if (animationTimer) clearTimeout(animationTimer)
    animationTimer = setTimeout(() => {
      context.setIsAnimating(false)
      // Recompute against settled geometry — picks up any window resize
      // that happened during the animation.
      layoutPass()
    }, SETTLE_MS)
  })

  return (
    <div class={styles.layoutBuilder}>
      <div class={styles.canvas} ref={canvasEl} data-canvas="true">
        <div class={styles.canvasInner} data-canvas-inner="true" ref={innerEl}>
          {props.children}
        </div>
        <Breadcrumb canvasAspect={canvasAspect} />
        <Contextual />
      </div>
    </div>
  )
}
