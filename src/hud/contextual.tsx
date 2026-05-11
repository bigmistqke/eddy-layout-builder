import { Show, useContext } from "solid-js"
import { HudButton } from "../components/hud-button"
import { PlusIcon, SplitIcon, TrashIcon } from "../components/icons"
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
          <HudButton
            data-action="delete"
            onClick={() => {
              logAction("delete")
              context.deleteSelection()
            }}
          >
            <TrashIcon />
          </HudButton>
          <Show when={context.app.tool !== null}>
            <HudButton
              active={context.app.tool === "append"}
              data-action="set-tool-append"
              onClick={() => {
                logAction("set-tool", { tool: "append" })
                context.setTool("append")
              }}
            >
              <PlusIcon />
            </HudButton>
            <HudButton
              active={context.app.tool === "split"}
              data-action="set-tool-split"
              onClick={() => {
                logAction("set-tool", { tool: "split" })
                context.setTool("split")
              }}
            >
              <SplitIcon />
            </HudButton>
          </Show>
        </div>
      </Notch>
    </Show>
  )
}
