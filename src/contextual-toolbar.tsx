import { getOwner, onCleanup, runWithOwner, Show, useContext } from "solid-js"
import { Context } from "./context"
import { Notch } from "./frame"
import { BackIcon } from "./icons"
import styles from "./contextual-toolbar.module.css"

export function ContextualToolbar() {
  const context = useContext(Context)!
  const owner = getOwner()
  const hasSelection = () => context.selection.path.length > 0
  const hasAnyButton = () => hasSelection()

  return (
    <Show when={hasAnyButton()}>
      <Notch
        ref={el => {
          context.setContextualToolbarEl(el)
          runWithOwner(owner, () => onCleanup(context.registerCollidable(el, "hud")))
        }}
        class={styles.toolbarNotch}
        orientation="right"
      >
        <div class={styles.toolbarContent}>
          <Show when={hasSelection()}>
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
