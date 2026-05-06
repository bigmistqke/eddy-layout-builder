import {
  ComponentProps,
  createEffect,
  createMemo,
  createSignal,
  For,
  onSettled,
  Show,
  untrack,
  useContext,
} from "solid-js"
import { Context } from "./context"
import { Notch } from "./frame"
import { ContextualToolbar } from "./contextual-toolbar"
import styles from "./layout-builder.module.css"
import type { Node } from "./types"
import {
  computeViewportTransform,
  IDENTITY_VIEWPORT,
  selectedPathKey,
  transformToCss,
} from "./viewport"

export function Breadcrumb() {
  const context = useContext(Context)!

  // Signal-driven collidable registration: ref just sets the signal, this
  // effect owns the lifecycle.
  createEffect(context.breadcrumbEl, el => {
    if (!el) return
    return context.registerCollidable(el, "hud")
  })

  const segments = createMemo(() => {
    const { path } = context.selection
    const segs: Array<{ label: string; depth: number }> = []

    segs.push({
      label: context.app.layout.direction === "vertical" ? "col" : "row",
      depth: path.length,
    })

    let current: Node = context.app.layout
    for (let i = 0; i < path.length; i++) {
      if (current.type !== "container") break
      current = current.children[path[i]]
      const depth = path.length - 1 - i
      if (current.type === "container") {
        segs.push({
          label: current.direction === "vertical" ? "col" : "row",
          depth,
        })
      } else {
        segs.push({
          label: String(path[i] + 1),
          depth: 0,
        })
      }
    }

    return segs
  })

  return (
    <Notch
      ref={context.setBreadcrumbEl}
      class={styles.breadcrumbNotch}
      orientation="top"
    >
      <div class={styles.breadcrumbContent}>
        <For each={segments()}>
          {(seg, i) => (
            <>
              <Show when={i() > 0}>
                <span class={styles.separator}>&gt;</span>
              </Show>
              <button
                class={seg().depth === context.selection.depth ? styles.active : ""}
                onClick={() => context.setSelection(s => ({ ...s, depth: seg().depth }))}
              >
                {seg().label}
              </button>
            </>
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
  const [viewport, setViewport] = createSignal<ViewportState>(INITIAL_VIEWPORT, {
    ownedWrite: true,
    equals: (a, b) =>
      a.scale === b.scale &&
      a.x === b.x &&
      a.y === b.y &&
      a.baseW === b.baseW &&
      a.baseH === b.baseH,
  })
  const [resizeTick, setResizeTick] = createSignal(0)

  onSettled(() => {
    if (!canvasEl) return
    // Seed baseW/baseH immediately so the very first render has explicit
    // pixel dimensions on canvasInner — required for width/height transitions
    // to animate (browsers won't interpolate between auto and a pixel value).
    const rect = canvasEl.getBoundingClientRect()
    setViewport(v => ({ ...v, baseW: rect.width, baseH: rect.height }))
    return context.observeFrame(canvasEl, () => setResizeTick(t => t + 1))
  })

  // Returns a tuple so the effect re-runs whenever either dep changes.
  // (Solid 2.x's createEffect memoizes on the compute's return value, so
  // returning a string would skip the effect when resizeTick changes but
  // the selection key happens to be the same.)
  createEffect(
    () => [resizeTick(), selectedPathKey(context.selection)] as const,
    ([, key]) => {
      if (!innerEl || !canvasEl) return
      const rect = canvasEl.getBoundingClientRect()
      const baseW = rect.width
      const baseH = rect.height

      // Empty key = no selection (back button cleared it). Reset to identity.
      if (key === "") {
        setViewport({ ...IDENTITY_VIEWPORT, baseW, baseH })
        return
      }
      const node = innerEl.querySelector<HTMLElement>(`[data-path="${key}"]`)
      if (!node) return

      // Always fit the new selection. The viewport signal's `equals` short-
      // circuits identity→identity (so tapping a normal frame at scale 1 is
      // a no-op), but tapping a normal/large frame while zoomed correctly
      // animates back out to fit it.
      const prev = untrack(() => viewport())
      const t = computeViewportTransform(node, innerEl, baseW, baseH, prev.scale)
      setViewport({ ...t, baseW, baseH })
    },
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
      // Final settle: now that the canvas has reached its target size,
      // re-check collisions so handles render in their correct end state.
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
        <Breadcrumb />
        <ContextualToolbar />
      </div>
    </div>
  )
}
