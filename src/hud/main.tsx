import { createEffect, createSignal, isPending, Show, untrack, useContext } from "solid-js"
import { HudButton } from "../components/hud-button"
import {
  PlayIcon,
  PlusIcon,
  RecordIcon,
  RecordingActiveIcon,
  StopIcon,
} from "../components/icons"
import { Notch } from "../components/notch"
import { Context } from "../context"
import { blobToClip } from "../clips/clip"
import { startCapture, type CaptureHandle } from "../media/capture"
import { logAction, selectedCellId } from "../utils"
import styles from "./main.module.css"

export function Main() {
  const context = useContext(Context)!
  const [captureHandle, setCaptureHandle] = createSignal<CaptureHandle | null>(null)

  // Trigger camera acquisition reactively. `preview.stream` is a
  // function-form async signal — reading it kicks off `getUserMedia`.
  // The compute reads it directly (no try/catch) so the NotReadyError
  // propagates: Solid suspends the effect until the stream resolves,
  // then re-runs and the apply receives the MediaStream.
  createEffect(
    () => {
      if (context.previewTargetCellId() === null) {
        return null
      }
      return context.preview.stream()
    },
    () => {},
  )

  function toggleAddMode() {
    // Single bottom-bar "+" enters/exits add mode. Default tool on
    // entry is "split"; the contextual bar lets the user switch to
    // "append" once in tool mode.
    const next = context.app.tool === null ? "split" : null
    logAction("set-tool", { tool: next })
    context.setTool(next)
  }

  async function onRecord() {
    const cellId = selectedCellId(context)
    if (cellId === null) {
      return
    }
    logAction("record-start", {})
    // Pressing record collapses the layout-editing UI — recording is a
    // song-mode action, not an edit-mode action.
    if (context.app.tool !== null) {
      context.setTool(null)
    }
    // Force the selection into the previewing state regardless of how
    // we got here (post-record toggle, layout-edit, etc.). The capture
    // path needs the camera shown in the target cell.
    const selection = context.app.selection
    if (selection !== null && !selection.preview) {
      context.setSelection({ ...selection, preview: true })
    }

    // Monitor: play existing voices through speakers while we record.
    // Caller expected to use headphones; spec accepts mic leak otherwise.
    const existing = Object.values(context.clips.clips).filter(clip => clip.cellId !== cellId)
    const length = context.songLength()
    if (existing.length > 0) {
      await context.transport.play(existing, length)
    }

    // Stream is guaranteed resolved by the time onRecord can fire — the
    // record button is disabled while `preview.isLoading()`. Reading
    // outside a reactive scope is safe once the async signal has settled.
    const stream = untrack(context.preview.stream)
    if (stream === null) {
      return
    }
    const handle = startCapture(stream)
    setCaptureHandle(handle)

    // Anchor-take: auto-stop at songLength if set.
    if (length !== null) {
      window.setTimeout(() => {
        if (captureHandle() === handle) {
          void onStopRecording()
        }
      }, length * 1000)
    }
  }

  async function onStopRecording() {
    const handle = captureHandle()
    if (handle === null) {
      return
    }
    const cellId = untrack(context.previewTargetCellId)
    logAction("record-stop", {})
    setCaptureHandle(null)
    // Flip into the post-record state: keep the selection, drop the
    // preview flag. The previewTargetCellId memo reacts and clears
    // itself, so the just-recorded cell stops showing the camera and
    // shows the clip's frame 0 instead.
    const selection = context.app.selection
    if (selection !== null) {
      context.setSelection({ ...selection, preview: false })
    }
    context.transport.stop() // stop monitor playback if it was running
    const blob = await handle.stop()
    if (cellId === null) {
      return
    }
    const clip = await blobToClip(cellId, blob)
    context.clips.setClip(cellId, clip)
    if (context.songLength() === null) {
      context.setSongLength(clip.duration)
    }
    // Autoplay: once a recording lands, start the song so the user
    // hears the result without an extra tap.
    const allClips = Object.values(context.clips.clips)
    if (allClips.length > 0) {
      await context.transport.play(allClips, context.songLength())
    }
  }

  async function onPlay() {
    const allClips = Object.values(context.clips.clips)
    if (allClips.length === 0) {
      return
    }
    logAction("play", {})
    if (context.app.tool !== null) {
      context.setTool(null)
    }
    await context.transport.play(allClips, context.songLength())
  }

  function onStopPlayback() {
    logAction("stop", {})
    context.transport.stop()
  }

  return (
    <Notch ref={context.setHudElement("main")} class={styles.notch}>
      <div class={styles.content}>
        <Show
          when={context.transport.state() === "stopped"}
          fallback={
            <HudButton data-action="stop" onClick={onStopPlayback}>
              <StopIcon />
            </HudButton>
          }
        >
          <HudButton data-action="play" onClick={onPlay}>
            <PlayIcon />
          </HudButton>
        </Show>
        <Show
          when={captureHandle() !== null}
          fallback={
            <HudButton
              data-action="record-start"
              disabled={selectedCellId(context) === null || isPending(context.preview.stream)}
              onClick={onRecord}
            >
              <RecordIcon />
            </HudButton>
          }
        >
          <HudButton data-action="record-stop" onClick={onStopRecording}>
            <RecordingActiveIcon />
          </HudButton>
        </Show>
        <HudButton
          active={context.app.tool !== null}
          data-action="toggle-add"
          onClick={toggleAddMode}
        >
          <PlusIcon />
        </HudButton>
      </div>
    </Notch>
  )
}
