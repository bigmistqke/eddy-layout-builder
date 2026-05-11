import { useContext } from "solid-js"
import { PlusIcon, SplitIcon, TrashIcon } from "../components/icons"
import { ProjectMenu } from "../components/project-menu"
import { Context } from "../context"
import type { Tool } from "../types"
import { logAction } from "../utils"
import { Hud } from "./hud"

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
    <Hud kind="contextual" position="top-right" orientation="right">
      <ProjectMenu />
      <Hud.Button
        data-action="delete"
        disabled={context.app.selection === null}
        onClick={() => {
          logAction("delete")
          context.deleteSelection()
        }}
      >
        <TrashIcon />
      </Hud.Button>
      <Hud.Button
        active={context.app.tool === "append"}
        data-action="set-tool-append"
        onClick={() => setToolToggle("append")}
      >
        <PlusIcon />
      </Hud.Button>
      <Hud.Button
        active={context.app.tool === "split"}
        data-action="set-tool-split"
        onClick={() => setToolToggle("split")}
      >
        <SplitIcon />
      </Hud.Button>
    </Hud>
  )
}
