import { createEffect, createSignal, Show, useContext } from "solid-js"
import { PlayIcon, PlusIcon, RecordIcon, SplitIcon, StopIcon } from "../components/icons"
import { Notch } from "../components/notch"
import { Context } from "../context"
import { blobToClip } from "../clips/clip"
import { startCapture, type CaptureHandle } from "../media/capture"
import { logAction, selectedCellId } from "../utils"
import styles from "./main.module.css"

export function Main() {
  const context = useContext(Context)!
  const [captureHandle, setCaptureHandle] = createSignal<CaptureHandle | null>(null)

  // In split/append mode the currently-selected cell becomes the live
  // preview target — the user sees the camera in the cell they're
  // about to record into. During an active recording, the captured
  // cell stays the target. Outside tool mode + no recording, no
  // preview target.
  createEffect(
    () => ({
      tool: context.app.tool,
      selectedId: selectedCellId(context),
      recording: captureHandle() !== null,
    }),
    ({ tool, selectedId, recording }) => {
      if (recording) {
        // Don't change the target mid-recording — onRecord locked it.
        return
      }
      if (tool !== null && selectedId !== null) {
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
          when={captureHandle() !== null}
          fallback={
            <>
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
              <button class={styles.button} data-action="record-start" onClick={onRecord}>
                <RecordIcon />
              </button>
            </>
          }
        >
          <button class={styles.button} data-action="record-stop" onClick={onStopRecording}>
            <StopIcon />
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
