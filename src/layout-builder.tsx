import {
  ComponentProps,
  createEffect,
  createMemo,
  createSignal,
  For,
  getOwner,
  onCleanup,
  runWithOwner,
  Show,
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
  const owner = getOwner()

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
      ref={el => {
        context.setBreadcrumbEl(el)
        runWithOwner(owner, () => onCleanup(context.registerCollidable(el, "hud")))
      }}
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

export function LayoutBuilder(props: { children: ComponentProps<"div">["children"] }) {
  const context = useContext(Context)!
  let canvasEl!: HTMLDivElement
  let innerEl!: HTMLDivElement
  const [transform, setTransform] = createSignal(IDENTITY_VIEWPORT)

  createEffect(
    () => selectedPathKey(context.selection),
    key => {
      if (!innerEl || !canvasEl) return

      if (key === "") {
        setTransform(IDENTITY_VIEWPORT)
        return
      }

      const node = innerEl.querySelector<HTMLElement>(`[data-path="${key}"]`)
      if (!node) {
        setTransform(IDENTITY_VIEWPORT)
        return
      }

      const rect = canvasEl.getBoundingClientRect()
      setTransform(computeViewportTransform(node, innerEl, rect.width, rect.height))
    },
  )

  return (
    <div class={styles.layoutBuilder}>
      <div class={styles.canvas} ref={canvasEl}>
        <div
          class={styles.canvasInner}
          ref={innerEl}
          style={{
            transform: transformToCss(transform()),
            "--canvas-scale": String(transform().scale),
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
