import { createEffect, Show, useContext } from "solid-js"
import { Context } from "./context"
import { Notch } from "./frame"
import { BackIcon } from "./icons"
import styles from "./contextual-toolbar.module.css"

export function ContextualToolbar() {
  const context = useContext(Context)!
  // Back button only makes sense when the canvas is actually zoomed in.
  // Future buttons would OR their own conditions in here.
  const hasAnyButton = () => context.isCanvasZoomed()

  // Signal-driven collidable registration: ref just sets the signal, this
  // effect owns the lifecycle. Cleanup is the effect callback's return
  // value and fires automatically on owner disposal or signal change.
  createEffect(context.contextualToolbarEl, el => {
    if (!el) return
    return context.registerCollidable(el, "hud")
  })

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
              onClick={() => context.setSelection(() => ({ path: [], depth: 0 }))}
            >
              <BackIcon />
            </button>
          </Show>
        </div>
      </Notch>
    </Show>
  )
}
