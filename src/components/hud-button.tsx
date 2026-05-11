import { omit, type ComponentProps } from "solid-js"
import styles from "./hud-button.module.css"

interface HudButtonProps extends Omit<ComponentProps<"button">, "class"> {
  active?: boolean
}

/** Shared HUD button shell — square, no fill, current-color icon, with
 *  an `active` flip to the inverted color tokens. Used by both the main
 *  and contextual bars; `data-action="record-start"` gets its red
 *  treatment (and disabled state) from the shared stylesheet. */
export function HudButton(props: HudButtonProps) {
  const rest = omit(props, "active")
  return (
    <button {...rest} class={[styles.button, { [styles.active]: props.active === true }]} />
  )
}
