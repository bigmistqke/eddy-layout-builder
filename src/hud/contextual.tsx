import { Show, useContext } from "solid-js"
import { CloseIcon, PlusIcon, SplitIcon, TrashIcon } from "../components/icons"
import { Notch } from "../components/notch"
import { Context } from "../context"
import { logAction } from "../utils"
import styles from "./contextual.module.css"

export function Contextual() {
  const context = useContext(Context)!
  // Contextual is visible whenever there's a selection. The tool-picker
  // buttons (append/split) only appear once the user has entered add
  // mode via the main bar's `+`; otherwise the bar only carries the
  // universal deselect/delete actions.
  const isOpen = () => context.app.selection !== null

  return (
    <Show when={isOpen()}>
      <Notch ref={context.setHudElement("contextual")} class={styles.notch} orientation="right">
        <div class={styles.content}>
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
          <button
            class={styles.button}
            data-action="delete"
            onClick={() => {
              logAction("delete")
              context.deleteSelection()
            }}
          >
            <TrashIcon />
          </button>
          <Show when={context.app.tool !== null}>
            <button
              class={[styles.button, { [styles.active]: context.app.tool === "append" }]}
              data-action="set-tool-append"
              onClick={() => {
                logAction("set-tool", { tool: "append" })
                context.setTool("append")
              }}
            >
              <PlusIcon />
            </button>
            <button
              class={[styles.button, { [styles.active]: context.app.tool === "split" }]}
              data-action="set-tool-split"
              onClick={() => {
                logAction("set-tool", { tool: "split" })
                context.setTool("split")
              }}
            >
              <SplitIcon />
            </button>
          </Show>
        </div>
      </Notch>
    </Show>
  )
}
