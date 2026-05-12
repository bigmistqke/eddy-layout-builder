import { omit, useContext, type ComponentProps, type JSX } from "solid-js"
import { ArrowIcon } from "../components/icons"
import { Context } from "../context"
import type { Direction, HudKind } from "../types"
import { capitalize } from "../utils"
import styles from "./hud.module.css"

// -- Notch ------------------------------------------------------------

export function Notch(props: {
  ref?: (element: HTMLDivElement) => void
  style?: JSX.CSSProperties
  children: JSX.Element
  class?: string | (string | undefined | false)[]
  onClick?(): void
  orientation?: "top" | "bottom" | "left" | "right"
  "data-direction"?: Direction
}) {
  return (
    <div
      ref={props.ref}
      class={[
        styles.notch,
        styles[`hud${capitalize(props.orientation ?? "bottom")}`],
        ...(Array.isArray(props.class)
          ? props.class
          : props.class !== undefined
            ? [props.class]
            : []),
      ]}
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
 *  rotational positioning class (.top/.bottom/.left/.right nested
 *  inside .notch) and the data-direction attribute. */
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

// -- Hud --------------------------------------------------------------

export type HudPosition = "bottom-center" | "bottom-right" | "top-left" | "top-right"

const POSITION_CLASS: Record<HudPosition, string> = {
  "bottom-center": styles.bottomCenter,
  "bottom-right": styles.bottomRight,
  "top-left": styles.topLeft,
  "top-right": styles.topRight,
}

/** A HUD-level Notch instance. Wires the canonical HUD-element ref via
 *  context.setHudElement(kind), applies the shared positioning class
 *  for the chosen edge, and wraps children in a flex content div.
 *  Per-HUD layout details (column/row, padding, scroll behaviour) go
 *  in the `contentClass` the caller passes. The button used inside
 *  HUDs is exposed as `Hud.Button` (see attachment at the bottom of
 *  this file). */
export function Hud(props: {
  kind: HudKind
  position: HudPosition
  orientation: "top" | "bottom" | "left" | "right"
  /** Extra class applied to the outer Notch — for HUD-specific
   *  constraints like max-width that need to sit on the wrapper. */
  class?: string
  contentClass?: string
  contentRef?: (element: HTMLDivElement) => void
  contentStyle?: JSX.CSSProperties
  children: JSX.Element
}) {
  const context = useContext(Context)!
  return (
    <Notch
      ref={context.setHudElement(props.kind)}
      class={[styles.hud, POSITION_CLASS[props.position], props.class]}
      orientation={props.orientation}
    >
      <div
        ref={props.contentRef}
        class={[styles.content, props.contentClass]}
        style={props.contentStyle}
      >
        {props.children}
      </div>
    </Notch>
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
