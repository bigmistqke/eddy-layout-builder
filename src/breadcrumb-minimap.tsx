import { For, Show } from "solid-js"
import styles from "./breadcrumb-minimap.module.css"
import type { Container, Node } from "./types"

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
export function MiniNode(props: { node: Node; highlightPath: number[] }) {
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
