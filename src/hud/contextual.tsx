import { useContext } from "solid-js"
import { HudButton } from "../components/hud-button"
import { PlusIcon, SplitIcon, TrashIcon } from "../components/icons"
import { Notch } from "../components/notch"
import { Context } from "../context"
import type { Tool } from "../types"
import { logAction } from "../utils"
import styles from "./contextual.module.css"
import { ProjectMenu } from "./project-menu"

export function Contextual() {
  const context = useContext(Context)!

  // Tool buttons are toggles: tapping the active tool clears it,
  // tapping the inactive tool switches to it. Record/play also clear
  // the tool (see hud/main.tsx).
  function setToolToggle(tool: Tool) {
    const next = context.app.tool === tool ? null : tool
    logAction("set-tool", { tool: next })
    context.setTool(next)
  }

  return (
    <Notch ref={context.setHudElement("contextual")} class={styles.notch} orientation="right">
      <div class={styles.content}>
        <ProjectMenu />
        <HudButton
          data-action="delete"
          disabled={context.app.selection === null}
          onClick={() => {
            logAction("delete")
            context.deleteSelection()
          }}
        >
          <TrashIcon />
        </HudButton>
        <HudButton
          active={context.app.tool === "append"}
          data-action="set-tool-append"
          onClick={() => setToolToggle("append")}
        >
          <PlusIcon />
        </HudButton>
        <HudButton
          active={context.app.tool === "split"}
          data-action="set-tool-split"
          onClick={() => setToolToggle("split")}
        >
          <SplitIcon />
        </HudButton>
      </div>
    </Notch>
  )
}
