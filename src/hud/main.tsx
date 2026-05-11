import { createEffect, createSignal, Show, untrack, useContext } from "solid-js"
import {
  PlayIcon,
  PlusIcon,
  RecordIcon,
  RecordingActiveIcon,
  SplitIcon,
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

  // Camera lifecycle. The previewTargetCellId memo on AppContext is the
  // source of truth for "which cell shows the camera"; this effect just
  // mirrors it into preview.enable() so the camera comes up the moment
  // a target appears.
  createEffect(
    () => context.previewTargetCellId(),
    target => {
      if (target !== null) {
        void context.preview.enable()
      }
    },
  )

  function toggleTool(tool: "append" | "split") {
    const next = context.app.tool === tool ? null : tool
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

    await context.preview.enable()
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
            <button class={styles.button} data-action="stop" onClick={onStopPlayback}>
              <StopIcon />
            </button>
          }
        >
          <button class={styles.button} data-action="play" onClick={onPlay}>
            <PlayIcon />
          </button>
        </Show>
        <Show
          when={captureHandle() !== null}
          fallback={
            <button class={styles.button} data-action="record-start" onClick={onRecord}>
              <RecordIcon />
            </button>
          }
        >
          <button class={styles.button} data-action="record-stop" onClick={onStopRecording}>
            <RecordingActiveIcon />
          </button>
        </Show>
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
