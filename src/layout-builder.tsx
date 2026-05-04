import { ComponentProps, createMemo, For, Show, useContext } from "solid-js"
import { Context } from "./app"
import styles from "./layout-builder.module.css"
import type { Node } from "./types"

export function Breadcrumb() {
  const context = useContext(Context)!

  const segments = createMemo(() => {
    const { path } = context.selection
    const segs: Array<{ label: string; depth: number }> = []

    segs.push({ label: "root", depth: path.length })

    let current: Node = context.layout
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
          label: String.fromCharCode(65 + path[i]),
          depth: 0,
        })
      }
    }

    return segs
  })

  return (
    <div class={styles.breadcrumb}>
      <For each={segments()}>
        {(seg, i) => (
          <>
            <Show when={i() > 0}>
              <span class={styles.separator}>›</span>
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
  )
}

export function LayoutBuilder(props: {
  children: ComponentProps<"div">["children"]
  onDone(): void
}) {
  const context = useContext(Context)!

  return (
    <div class={styles.layoutBuilder}>
      <div class={styles.canvas}>
        <Breadcrumb />
        {props.children}
      </div>
      <div class={styles.bottomBar}>
        <div class={styles.modeToggle}>
          <button
            class={context.mode() === "append" ? styles.active : ""}
            onClick={() => context.setMode("append")}
          >
            ⊞ Append
          </button>
          <button
            class={context.mode() === "split" ? styles.active : ""}
            onClick={() => context.setMode("split")}
          >
            ÷ Split
          </button>
        </div>
        <button class={styles.doneButton} onClick={props.onDone}>
          Done
        </button>
      </div>
    </div>
  )
}
