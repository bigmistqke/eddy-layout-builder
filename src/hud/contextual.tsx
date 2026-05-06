import { Show, useContext } from "solid-js"
import { Context } from "../context"
import { Notch } from "../notch"
import { BackIcon } from "../icons"
import { logAction } from "../utils"
import styles from "./contextual.module.css"

export function Contextual() {
  const context = useContext(Context)!
  // Back button only makes sense when the canvas is actually zoomed in.
  // Future buttons would OR their own conditions in here.
  const hasAnyButton = () => context.isCanvasZoomed()

  return (
    <Show when={hasAnyButton()}>
      <Notch
        ref={context.setContextualToolbarEl}
        class={styles.notch}
        orientation="right"
      >
        <div class={styles.content}>
          <Show when={context.isCanvasZoomed()}>
            <button
              class={styles.button}
              data-action="back"
              onClick={() => {
                logAction("back")
                context.setSelection(() => ({ path: [], depth: 0 }))
              }}
            >
              <BackIcon />
            </button>
          </Show>
        </div>
      </Notch>
    </Show>
  )
}
