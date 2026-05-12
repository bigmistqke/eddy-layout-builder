import { Show, useContext } from "solid-js"
import { Context } from "../context"
import { selectedCellId } from "../utils"
import styles from "./audio-volume.module.css"
import { Hud } from "./hud"

/** Bottom-right HUD with the per-cell volume slider. Mounts only in
 *  audio mode with a leaf selection; controls the selected cell's
 *  volume via clips.setCellVolume. Disabled when the selected cell
 *  has no clip yet. */
export function AudioVolume() {
  const context = useContext(Context)!
  const cellId = () => (context.app.tool === "audio" ? selectedCellId(context) : null)
  return (
    <Show when={cellId()}>
      {id => {
        const hasClip = () => context.clips.cellIds().includes(id())
        return (
          <Hud
            kind="audio"
            position="bottom-right"
            orientation="bottom"
            contentClass={styles.content}
          >
            <input
              class={styles.slider}
              data-action="set-cell-volume"
              data-audio-cell={id()}
              type="range"
              min="0"
              max="1.5"
              step="0.01"
              disabled={!hasClip()}
              value={context.clips.cellVolume(id())}
              onInput={event => {
                context.clips.setCellVolume(
                  id(),
                  Number((event.currentTarget as HTMLInputElement).value),
                )
              }}
            />
          </Hud>
        )
      }}
    </Show>
  )
}
