import { type JSX } from "solid-js"
import type { Direction } from "../types"
import { capitalize } from "../utils"
import { ArrowIcon } from "./icons"
import styles from "./notch.module.css"

export function Notch(props: {
  ref?: (element: HTMLDivElement) => void
  style?: JSX.CSSProperties
  children: JSX.Element
  class?: string
  onClick?(): void
  orientation?: "top" | "bottom" | "left" | "right"
  "data-direction"?: Direction
}) {
  return (
    <div
      ref={props.ref}
      class={[styles.notch, styles[`hud${capitalize(props.orientation ?? "bottom")}`], props.class]}
      style={props.style}
      data-direction={props["data-direction"]}
      onClick={event => event.stopPropagation()}
    >
      <div class={styles.notchBackdrop}>
        <div class={styles.edge} onClick={props.onClick} />
        <div class={styles.center} onClick={props.onClick} />
        <div class={styles.root} onClick={props.onClick} />
      </div>
      {props.children}
    </div>
  )
}

/** A directional notch with the arrow icon — used for the four edge
 *  handles on a selected Frame. The `direction` prop sets both the
 *  rotational positioning class (.top/.bottom/.left/.right nested inside
 *  .notch in notch.module.css) and the data-direction attribute. */
export function ArrowNotch(props: {
  style?: JSX.CSSProperties
  direction: Direction
  onClick?(): void
}) {
  return (
    <Notch
      style={props.style}
      class={styles[props.direction]}
      onClick={props.onClick}
      data-direction={props.direction}
    >
      <ArrowIcon class={styles.arrow} />
    </Notch>
  )
}
