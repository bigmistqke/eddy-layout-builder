import {
  Accessor,
  createMemo,
  For,
  Show,
  useContext,
} from "solid-js"
import { Context } from "../context"
import { Notch } from "../frame"
import type { Container, Node } from "../types"
import { logAction } from "../utils"
import styles from "./breadcrumb.module.css"

/**
 * Recursive minimap renderer.
 *
 * `highlightPath` is the path *from this node* to the highlighted descendant.
 * - `highlightPath.length === 0` → this node is the highlighted one.
 * - `highlightPath = [-1]` (any non-matching head) → no descendant is highlighted.
 *
 * Mirrors the real layout's flex behavior at thumbnail scale: containers are
 * flex row/col matching their `direction`, entities are unit-flex cells.
 * Gaps and padding are not faithfully reproduced.
 */
function MiniNode(props: { node: Node; highlightPath: number[] }) {
  const isHighlighted = () => props.highlightPath.length === 0
  return (
    <Show
      when={props.node.type === "container"}
      fallback={
        <div
          class={[styles.miniCell, isHighlighted() && styles.miniHighlight]
            .filter(Boolean)
            .join(" ")}
        />
      }
    >
      <MiniContainer container={props.node as Container} highlightPath={props.highlightPath} />
    </Show>
  )
}

function MiniContainer(props: { container: Container; highlightPath: number[] }) {
  const isHighlighted = () => props.highlightPath.length === 0
  const head = () => (props.highlightPath.length > 0 ? props.highlightPath[0] : -1)
  const rest = () => props.highlightPath.slice(1)

  return (
    <div
      class={[
        styles.miniContainer,
        props.container.direction === "vertical" ? styles.col : styles.row,
        isHighlighted() && styles.miniHighlight,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <For each={props.container.children}>
        {(child, i) => (
          <MiniNode node={child()} highlightPath={i() === head() ? rest() : [-1]} />
        )}
      </For>
    </div>
  )
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

  return (
    <Notch ref={context.setBreadcrumbEl} class={styles.notch} orientation="top">
      <div class={styles.content}>
        <For each={segments()}>
          {(seg, i) => (
            <button
              class={[
                styles.button,
                seg().depth === context.selection.depth ? styles.active : "",
              ].join(" ")}
              style={{ "aspect-ratio": props.canvasAspect() }}
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
