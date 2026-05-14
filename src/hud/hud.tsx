import { omit, useContext, type ComponentProps, type JSX } from "solid-js"
import { ArrowIcon } from "../components/icons"
import { Context } from "../context"
import type { Direction, HudOrientation } from "../types"
import styles from "./hud.module.css"

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

// -- Hud --------------------------------------------------------------

export type HudPosition = "bottom-center" | "middle-right" | "top-left" | "top-right"

const POSITION_CLASS: Record<HudPosition, string> = {
  "bottom-center": styles.bottomCenter,
  "middle-right": styles.middleRight,
  "top-left": styles.topLeft,
  "top-right": styles.topRight,
}

const ORIENTATION_CLASS: Record<HudOrientation, string> = {
  horizontal: styles.horizontal,
  vertical: styles.vertical,
}

/** A HUD-level Notch instance. Wires the canonical HUD-element ref via
 *  context.setHudElement(orientation), applies the shared positioning class
 *  for the chosen edge, and wraps children in a flex content div.
 *  Per-HUD layout details (column/row, padding, scroll behaviour) go
 *  in the `contentClass` the caller passes. The button used inside
 *  HUDs is exposed as `Hud.Button` (see attachment at the bottom of
 *  this file). */
export function Hud(props: {
  position: HudPosition
  orientation: HudOrientation
  /** Extra class applied to the outer wrapper — for HUD-specific
   *  constraints like max-width that need to sit on the wrapper. */
  class?: string
  contentClass?: string
  contentRef?: (element: HTMLDivElement) => void
  contentStyle?: JSX.CSSProperties
  children: JSX.Element
}) {
  const context = useContext(Context)!
  return (
    <div
      class={[
        styles.hud,
        POSITION_CLASS[props.position],
        ORIENTATION_CLASS[props.orientation],
        props.class,
      ]}
      onClick={event => event.stopPropagation()}
      ref={context.setHudElement(props.orientation)}
    >
      <div
        ref={props.contentRef}
        class={[styles.content, props.contentClass]}
        style={props.contentStyle}
      >
        {props.children}
      </div>
    </div>
  )
}

// -- Hud.Button -------------------------------------------------------

interface HudButtonProps extends Omit<ComponentProps<"button">, "class"> {
  active?: boolean
  class?: string
}

/** Shared HUD button shell — square, no fill, current-color icon,
 *  with an `active` flip to the inverted color tokens. Used by both
 *  the main and contextual bars; `data-action="record-start"` gets
 *  its red treatment (and disabled state) from the shared
 *  stylesheet. Attached as `Hud.Button` below. */
function HudButton(props: HudButtonProps) {
  const rest = omit(props, "active", "class")
  return (
    <button
      {...rest}
      class={[styles.button, props.class, { [styles.active]: props.active === true }]}
    />
  )
}

Hud.Button = HudButton
