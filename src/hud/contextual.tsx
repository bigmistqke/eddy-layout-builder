import { Show, useContext } from "solid-js"
import { PlusIcon, SplitIcon, TrashIcon } from "../components/icons"
import { Context } from "../context"
import { logAction, selectedCellId } from "../utils"
import styles from "./contextual.module.css"
import { Hud } from "./hud"

/** Edit-mode tool-bar. Sits in the middle-right grid cell, underneath
 *  the always-visible hamburger menu. Contents scroll vertically when
 *  they'd exceed the available height (e.g. small viewport with a tall
 *  volume slider). Mounted only while Edit is on; the cycle button
 *  flips between append/split, trash removes the selection, and the
 *  vertical slider drives the selected cell's volume. */
export function Contextual() {
  const context = useContext(Context)!

  function cycleSubMode() {
    const next = context.app.tool === "append" ? "split" : "append"
    logAction("set-tool", { tool: next })
    context.setTool(next)
  }

  return (
    <Show when={context.app.tool !== null}>
      <Hud
        position="middle-right"
        orientation="vertical"
        contentClass={styles.content}
      >
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
          data-action="cycle-sub-mode"
          data-tool={context.app.tool}
          onClick={cycleSubMode}
        >
          <Show when={context.app.tool === "append"} fallback={<SplitIcon />}>
            <PlusIcon />
          </Show>
        </Hud.Button>
        <Show
          when={(() => {
            const id = selectedCellId(context)
            return id !== null && context.clips.cellIds().includes(id) ? id : null
          })()}
        >
          {id => (
            <div class={styles.sliderContainer}>
              <input
                class={styles.slider}
                data-action="set-cell-volume"
                data-audio-cell={id()}
                type="range"
                min="0"
                max="1.5"
                step="0.01"
                value={context.clips.cellVolume(id())}
                onInput={event => {
                  context.clips.setCellVolume(
                    id(),
                    Number((event.currentTarget as HTMLInputElement).value),
                  )
                }}
              />
            </div>
          )}
        </Show>
      </Hud>
    </Show>
  )
}
