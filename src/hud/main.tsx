import { useContext } from "solid-js"
import { PlayIcon, PlusIcon, RecordIcon, SplitIcon } from "../components/icons"
import { Notch } from "../components/notch"
import { Context } from "../context"
import { logAction } from "../utils"
import styles from "./main.module.css"

export function Main() {
  const context = useContext(Context)!

  function toggleTool(tool: "append" | "split") {
    const next = context.app.tool === tool ? null : tool
    logAction("set-tool", { tool: next })
    context.setTool(next)
  }

  return (
    <Notch ref={context.setHudElement("main")} class={styles.notch}>
      <div class={styles.content}>
        <button class={styles.button}>
          <PlayIcon />
        </button>
        <button class={styles.button}>
          <RecordIcon />
        </button>
        <span class={styles.divider} />
        <button
          class={[styles.button, context.app.tool === "append" ? styles.active : ""].join(" ")}
          data-action="set-tool-append"
          onClick={() => toggleTool("append")}
        >
          <PlusIcon />
        </button>
        <button
          class={[styles.button, context.app.tool === "split" ? styles.active : ""].join(" ")}
          data-action="set-tool-split"
          onClick={() => toggleTool("split")}
        >
          <SplitIcon />
        </button>
      </div>
    </Notch>
  )
}
