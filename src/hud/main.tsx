import { createEffect, createSignal, Show, useContext } from "solid-js"
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

  // The currently-selected cell becomes the live preview target — but
  // only if it doesn't already have a clip. Selecting an empty cell
  // (whether in tool mode or not) shows the camera there; selecting a
  // cell with a clip shows that clip's frame 0 instead, so users can
  // browse their recordings without losing them under a preview.
  // During an active recording, onRecord locks the target.
  createEffect(
    () => {
      const selectedId = selectedCellId(context)
      // `clips.clips` is a plain Record (host-object safety; see store.ts);
      // reactivity comes from `cellIds()` which mirrors its key set.
      const cellIds = context.clips.cellIds()
      const hasClip = selectedId !== null && cellIds.includes(selectedId)
      const recording = captureHandle() !== null
      return { selectedId, hasClip, recording }
    },
    ({ selectedId, hasClip, recording }) => {
      if (recording) {
        return
      }
      if (selectedId !== null && !hasClip) {
        context.preview.setTargetCellId(selectedId)
        void context.preview.enable()
      } else {
        context.preview.setTargetCellId(null)
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

    // Monitor: play existing voices through speakers while we record.
    // Caller expected to use headphones; spec accepts mic leak otherwise.
    const existing = Object.values(context.clips.clips).filter(clip => clip.cellId !== cellId)
    const length = context.songLength()
    if (existing.length > 0) {
      await context.transport.play(existing, length)
    }

    await context.preview.enable()
    context.preview.setTargetCellId(cellId)
    const stream = context.preview.stream()
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
    const cellId = context.preview.targetCellId()
    logAction("record-stop", {})
    setCaptureHandle(null)
    context.preview.setTargetCellId(null) // let the watcher re-evaluate
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
