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
    if (node.type === "entity") {
      return "e"
    }
    return `${node.direction[0]}(${node.children.map(nodeSignature).join(",")})`
  }
  return `${nodeSignature(layout)}|${selection.path.join(".")}/${selection.depth}`
}

type ViewportState = ReturnType<typeof computeViewportTransform> & {
  // canvas viewport dimensions captured at the time of computation —
  // used to size canvasInner explicitly when zoomed.
  baseWidth: number
  baseHeight: number
}

const INITIAL_VIEWPORT: ViewportState = { ...IDENTITY_VIEWPORT, baseWidth: 0, baseHeight: 0 }

export function LayoutBuilder(props: { children: ComponentProps<"div">["children"] }) {
  const context = useContext(Context)!
  let canvasElement!: HTMLDivElement
  let innerElement!: HTMLDivElement
  // ownedWrite: signals can be written from the effect callback below
  // (which runs in unowned scope per @solidjs/signals, but this is a defensive
  // opt-in in case any caller path is owned).
  // equals: short-circuits no-op updates so re-running the effect with an
  // identical viewport doesn't trigger a JSX re-render or CSS transition.
  // Uses epsilon comparison because computeViewportTransform can produce
  // sub-pixel floating-point drift between calls — without this, a recompute
  // post-animation would be flagged as "changed" and start a new animation.
  const equalsWithin = (first: number, second: number, epsilon = 0.5) =>
    Math.abs(first - second) < epsilon
  // Canvas aspect ratio (width / height) — driven by the canvas ResizeObserver
  // and consumed by Breadcrumb to size minimap segments. Defaults to 1 until
  // the first measurement; the breadcrumb briefly renders square segments and
  // snaps once the observer fires.
  const [canvasAspect, setCanvasAspect] = createSignal(1, { ownedWrite: true })
  const [viewport, setViewport] = createSignal<ViewportState>(INITIAL_VIEWPORT, {
    ownedWrite: true,
    equals: (first, second) =>
      equalsWithin(first.scale, second.scale, 0.001) &&
      equalsWithin(first.x, second.x) &&
      equalsWithin(first.y, second.y) &&
      equalsWithin(first.baseWidth, second.baseWidth) &&
      equalsWithin(first.baseHeight, second.baseHeight),
  })
  // Imperative recompute: called from the selection-change effect, the
  // canvas-resize observer, and the post-animation settle. Short-circuits
  // while the canvas is mid-transition (ResizeObserver fires repeatedly as
  // canvasInner's width/height interpolate, and any setViewport call here
  // would retarget the CSS transition mid-flight).
  function layoutPass() {
    if (untrack(context.isAnimating)) {
      return
    }
    if (!canvasElement) {
      return
    }
    const canvasRect = canvasElement.getBoundingClientRect()
    const canvas = { width: canvasRect.width, height: canvasRect.height }

    // Read selection inside untrack — layoutPass is the createEffect
    // callback (non-tracking by default in Solid 2.x), but the store-proxy
    // reads still warn STRICT_READ_UNTRACKED. Re-firing is driven by the
    // compute via layoutSignature, so untrack is correct here.
    const selection = untrack(() => ({
      path: context.app.selection.path.slice(),
      depth: context.app.selection.depth,
    }))
    // Empty selection (back button cleared) is treated as "root scope" —
    // root frame still renders handles via NodeComponent.handles() because
    // its path matches the empty targetedPath. So compute handle state
    // for the root rect; computeViewportTransform returns identity for
    // any frame that fits naturally, so the canvas pan/zoom stays zero.
    const targetedDepth = selection.path.length - selection.depth
    const selectedPath = selection.path.slice(0, Math.max(0, targetedDepth))

    const hudRects = context.computeHudRects(canvasRect)
    const transform = untrack(() =>
      computeViewportTransform(context.app.layout, selectedPath, canvas, 1, hudRects),
    )

    // Real frame rect at the chosen scale — fixed-pixel padding/gap mean
    // the DOM rect at scale s is NOT baseRect × s. Recompute via flex math
    // at the scaled canvasInner size for accurate extend/stick checks.
    const realRect = untrack(() =>
      frameRect(context.app.layout, selectedPath, {
        width: canvas.width * transform.scale,
        height: canvas.height * transform.scale,
      }),
    )
    const postRect: Rect = {
      x: realRect.x + transform.x,
      y: realRect.y + transform.y,
      width: realRect.width,
      height: realRect.height,
    }
    const extend = computeExtends(postRect, hudRects)
    const stick = computeSticks(postRect, canvas)

    setViewport({ ...transform, baseWidth: canvas.width, baseHeight: canvas.height })
    context.setSelectedHandlesState({ extend, stick })
  }

  onSettled(() => {
    if (!canvasElement) {
      return
    }
    // Seed baseWidth/baseHeight so the first render has explicit pixel
    // dimensions on canvasInner — required for width/height transitions to
    // animate (browsers won't interpolate between auto and a pixel value).
    const initialRect = canvasElement.getBoundingClientRect()
    setViewport(viewport => ({
      ...viewport,
      baseWidth: initialRect.width,
      baseHeight: initialRect.height,
    }))
    setCanvasAspect(initialRect.height > 0 ? initialRect.width / initialRect.height : 1)
    const resizeObserver = new ResizeObserver(() => {
      const rect = canvasElement.getBoundingClientRect()
      if (rect.height > 0) {
        setCanvasAspect(rect.width / rect.height)
      }
      layoutPass()
    })
    resizeObserver.observe(canvasElement)
    return () => resizeObserver.disconnect()
  })

  // Selection or layout-topology change drives viewport recomputes.
  createEffect(
    () => layoutSignature(context.app.layout, context.app.selection),
    () => layoutPass(),
  )

  // Expose "is the canvas currently zoomed" so the contextual back button
  // can hide itself when there is nothing to zoom out of. Wrapped in a block
  // so the setter's return value isn't treated as a cleanup function.
  createEffect(
    () => {
      const current = viewport()
      // Any non-identity transform — including pan-only (scale=1, x or y != 0).
      return current.scale > 1 || Math.abs(current.x) > 0.5 || Math.abs(current.y) > 0.5
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
  let currentAnimation: Animation | undefined
  let animationTimer: ReturnType<typeof setTimeout> | undefined
  const ANIMATION_MS = 220
  const SETTLE_MS = ANIMATION_MS + 20

  createEffect(viewport, viewport => {
    if (!innerElement) {
      return
    }
    if (viewport.baseWidth === 0 || viewport.baseHeight === 0) {
      return
    }

    const toTransform = transformToCss(viewport)
    const toWidth = `${viewport.baseWidth * viewport.scale}px`
    const toHeight = `${viewport.baseHeight * viewport.scale}px`

    // Read the rendered "from" state. If a previous animation was running,
    // computedStyle reflects its current value (mid-interpolation), so the
    // new animation seamlessly continues from there.
    const computedStyle = getComputedStyle(innerElement)
    const fromTransform =
      computedStyle.transform === "none" ? "translate(0px, 0px)" : computedStyle.transform
    const fromWidth = computedStyle.width
    const fromHeight = computedStyle.height

    // Cancel any in-flight animation; we're replacing it with a new one
    // that starts from where the canvas actually IS right now.
    currentAnimation?.cancel()

    // Set the underlying inline style so post-animation the element rests
    // at the new state (fill: 'forwards' on the animation alone would also
    // work, but we want the underlying style to match for any consumer
    // reading style directly).
    innerElement.style.transform = toTransform
    innerElement.style.width = toWidth
    innerElement.style.height = toHeight

    currentAnimation = innerElement.animate(
      [
        { transform: fromTransform, width: fromWidth, height: fromHeight },
        { transform: toTransform, width: toWidth, height: toHeight },
      ],
      { duration: ANIMATION_MS, easing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "none" },
    )

    context.setIsAnimating(true)
    if (animationTimer) {
      clearTimeout(animationTimer)
    }
    animationTimer = setTimeout(() => {
      context.setIsAnimating(false)
      // Recompute against settled geometry — picks up any window resize
      // that happened during the animation.
      layoutPass()
    }, SETTLE_MS)
  })

  return (
    <div class={styles.layoutBuilder}>
      <div class={styles.canvas} ref={canvasElement} data-canvas="true">
        <div class={styles.canvasInner} data-canvas-inner="true" ref={innerElement}>
          {props.children}
        </div>
        <Breadcrumb canvasAspect={canvasAspect} />
        <Contextual />
      </div>
    </div>
  )
}
