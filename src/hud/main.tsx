import { Match, Switch, useContext } from "solid-js"
import { CloseIcon, PlayIcon, PlusIcon, RecordIcon, SplitIcon } from "../components/icons"
import { Notch } from "../components/notch"
import { Context } from "../context"
import { logAction } from "../utils"
import styles from "./main.module.css"

export function Main() {
  const context = useContext(Context)!
  const layoutView = () =>
    context.app.view.type === "layout"
      ? (context.app.view as { type: "layout"; mode: "append" | "split" })
      : null

  return (
    <Notch ref={context.setBottomBarEl} class={styles.notch}>
      <div class={styles.content}>
        <Switch>
          <Match when={context.app.view.type === "recording"}>
            <button class={styles.button}>
              <PlayIcon />
            </button>
            <button class={styles.button}>
              <RecordIcon />
            </button>
            <button
              class={styles.button}
              data-action="enter-layout"
              onClick={() => {
                logAction("enter-layout")
                context.setView({ type: "layout", mode: "append" })
              }}
            >
              <PlusIcon />
            </button>
          </Match>
          <Match when={context.app.view.type === "layout"}>
            <button
              class={[styles.button, layoutView()?.mode === "append" ? styles.active : ""]}
              data-action="set-mode-append"
              onClick={() => {
                logAction("set-mode", { mode: "append" })
                context.setView({ type: "layout", mode: "append" })
              }}
            >
              <PlusIcon />
            </button>
            <button
              class={[styles.button, layoutView()?.mode === "split" ? styles.active : ""]}
              data-action="set-mode-split"
              onClick={() => {
                logAction("set-mode", { mode: "split" })
                context.setView({ type: "layout", mode: "split" })
              }}
            >
              <SplitIcon />
            </button>
            <button
              class={styles.button}
              data-action="exit-layout"
              onClick={() => {
                logAction("exit-layout")
                context.setView({ type: "recording" })
              }}
            >
              <CloseIcon />
            </button>
          </Match>
        </Switch>
      </div>
    </Notch>
  )
}
