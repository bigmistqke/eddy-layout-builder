import { Show, useContext } from "solid-js"
import { logAction } from "./actions-log"
import { Context } from "./context"
import { Notch } from "./frame"
import { BackIcon } from "./icons"
import styles from "./contextual-toolbar.module.css"

export function ContextualToolbar() {
  const context = useContext(Context)!
  // Back button only makes sense when the canvas is actually zoomed in.
  // Future buttons would OR their own conditions in here.
  const hasAnyButton = () => context.isCanvasZoomed()

  return (
    <Show when={hasAnyButton()}>
      <Notch
        ref={context.setContextualToolbarEl}
        class={styles.toolbarNotch}
        orientation="right"
      >
        <div class={styles.toolbarContent}>
          <Show when={context.isCanvasZoomed()}>
            <button
              class={styles.toolbarButton}
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
