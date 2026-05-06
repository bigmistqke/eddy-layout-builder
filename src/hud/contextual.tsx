import { Show, useContext } from "solid-js"
import { CloseIcon } from "../components/icons"
import { Notch } from "../components/notch"
import { Context } from "../context"
import { logAction } from "../utils"
import styles from "./contextual.module.css"

export function Contextual() {
  const context = useContext(Context)
  // Deselect button shows when a tool is active and a frame is selected.
  // Without an active tool the contextual HUD has nothing to offer.
  const hasSelection = () =>
    context.app.tool !== null && context.app.selection !== null
  const hasAnyButton = () => hasSelection()

  return (
    <Show when={hasAnyButton()}>
      <Notch ref={context.setHudElement("contextual")} class={styles.notch} orientation="right">
        <div class={styles.content}>
          <Show when={hasSelection()}>
            <button
              class={styles.button}
              data-action="deselect"
              onClick={() => {
                logAction("deselect")
                context.setSelection(null)
              }}
            >
              <CloseIcon />
            </button>
          </Show>
        </div>
      </Notch>
    </Show>
  )
}
