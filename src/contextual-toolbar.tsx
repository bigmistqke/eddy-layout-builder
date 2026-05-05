import { getOwner, onCleanup, runWithOwner, Show, useContext } from "solid-js"
import { Context } from "./context"
import { Notch } from "./frame"
import { BackIcon } from "./icons"
import styles from "./contextual-toolbar.module.css"

export function ContextualToolbar() {
  const context = useContext(Context)!
  const owner = getOwner()
  // Back button only makes sense when the canvas is actually zoomed in.
  // Future buttons would OR their own conditions in here.
  const hasAnyButton = () => context.isCanvasZoomed()

  return (
    <Show when={hasAnyButton()}>
      <Notch
        ref={el => {
          context.setContextualToolbarEl(el)
          // See app.tsx for why register runs outside runWithOwner.
          const unregister = context.registerCollidable(el, "hud")
          runWithOwner(owner, () => onCleanup(unregister))
        }}
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
