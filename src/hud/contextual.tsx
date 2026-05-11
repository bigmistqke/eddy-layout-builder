import { Show, useContext } from "solid-js"
import { HudButton } from "../components/hud-button"
import { PlusIcon, SplitIcon, TrashIcon } from "../components/icons"
import { Notch } from "../components/notch"
import { Context } from "../context"
import { logAction } from "../utils"
import styles from "./contextual.module.css"
import { ProjectMenu } from "./project-menu"

export function Contextual() {
  const context = useContext(Context)!

  return (
    <Notch ref={context.setHudElement("contextual")} class={styles.notch} orientation="right">
      <div class={styles.content}>
        <ProjectMenu />
        <Show when={context.app.selection !== null}>
          <HudButton
            data-action="delete"
            onClick={() => {
              logAction("delete")
              context.deleteSelection()
            }}
          >
            <TrashIcon />
          </HudButton>
        </Show>
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
  )
}
