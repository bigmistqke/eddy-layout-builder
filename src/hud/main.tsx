import { Match, Switch, useContext } from "solid-js"
import { Context } from "../context"
import { Notch } from "../frame"
import { CloseIcon, PlayIcon, PlusIcon, RecordIcon, SplitIcon } from "../icons"
import { logAction } from "../utils"
import styles from "./main.module.css"

export function Main(props: {
  onEnterLayout: () => void
  onSetSplitMode: () => void
  onExitLayout: () => void
}) {
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
            <button
              class={styles.button}
              data-action="enter-layout"
              onClick={() => {
                logAction("enter-layout")
                props.onEnterLayout()
              }}
            >
              <PlusIcon />
            </button>
            <button class={styles.button}>
              <RecordIcon />
            </button>
            <button class={styles.button}>
              <PlayIcon />
            </button>
          </Match>
          <Match when={context.app.view.type === "layout"}>
            <button
              class={[
                styles.modeButton,
                layoutView()?.mode === "append" ? styles.active : "",
              ]}
              data-action="set-mode-append"
              onClick={() => {
                logAction("set-mode", { mode: "append" })
                props.onEnterLayout()
              }}
            >
              <PlusIcon />
            </button>
            <button
              class={[
                styles.modeButton,
                layoutView()?.mode === "split" ? styles.active : "",
              ]}
              data-action="set-mode-split"
              onClick={() => {
                logAction("set-mode", { mode: "split" })
                props.onSetSplitMode()
              }}
            >
              <SplitIcon />
            </button>
            <button
              class={styles.button}
              data-action="exit-layout"
              onClick={() => {
                logAction("exit-layout")
                props.onExitLayout()
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
