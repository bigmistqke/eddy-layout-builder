import type { JSX } from "solid-js"
import { ArrowIcon } from "../components/icons"
import { Direction } from "../types"
import styles from "./arrow-button.module.css"

/** A directional notch with the arrow icon — used for the four edge
 *  handles on a selected Frame. The `direction` prop sets both the
 *  rotational positioning class (.top/.bottom/.left/.right nested
 *  inside .notch) and the data-direction attribute. */
export function ArrowButton(props: {
  style?: JSX.CSSProperties
  direction: Direction
  onClick?(): void
}) {
  return (
    <button
      style={props.style}
      class={[styles.arrowButton, styles[props.direction]]}
      onClick={event => {
        // Don't let the click bubble to the canvas wrapper — the canvas
        // tap handler would otherwise hit-test the click position and
        // reassign selection (possibly overriding the new-frame
        // selection that split/append just set).
        event.stopPropagation()
        props.onClick?.()
      }}
      data-direction={props.direction}
    >
      <ArrowIcon class={styles.arrow} />
    </button>
  )
}
