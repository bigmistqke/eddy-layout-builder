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
  const [viewport, setViewport] = createSignal<ViewportState>(INITIAL_VIEWPORT)
  const [resizeTick, setResizeTick] = createSignal(0)

  onSettled(() => {
    if (!canvasEl) return
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

      if (key === "") {
        setViewport({ ...IDENTITY_VIEWPORT, baseW, baseH })
        return
      }
      const node = innerEl.querySelector<HTMLElement>(`[data-path="${key}"]`)
      if (!node) {
        setViewport({ ...IDENTITY_VIEWPORT, baseW, baseH })
        return
      }
      // Pass the current scale so the math can recover base-size measurements
      // from the currently-rendered (zoom-multiplied) ones. Read via untrack
      // because we're in an effect callback (unowned, untracked scope).
      const currentScale = untrack(() => viewport().scale)
      const t = computeViewportTransform(node, innerEl, baseW, baseH, currentScale)
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

  // Only set explicit width/height when zoomed. At scale = 1, leave it
  // unset so the .canvasInner CSS `inset: 0` fills the parent naturally —
  // initial render (scale = 1, baseW/H = 0) wouldn't otherwise have
  // measured the canvas yet.
  const sizing = () => {
    const v = viewport()
    if (v.scale <= 1) return { width: undefined, height: undefined }
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
