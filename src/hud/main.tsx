import { createSignal, isPending, latest, Loading, Show, untrack, useContext } from "solid-js"
import { blobToClip } from "../clips/clip"
import {
  EditIcon,
  PlayIcon,
  RecordIcon,
  RecordingActiveIcon,
  StopIcon,
} from "../components/icons"
import { Context } from "../context"
import { useDirectOutput, useMediaStreamOutput } from "../media/audio-context"
import { startCapture, type CaptureHandle } from "../media/capture"
import { logAction, logTrace, run, selectedCellId } from "../utils"
import { Hud } from "./hud"

export function Main() {
  const context = useContext(Context)!
  const [captureHandle, setCaptureHandle] = createSignal<CaptureHandle | null>(null)

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
    let length = context.songLength()
    // "New anchor" rule: when re-recording the only clip in the song,
    // the new take redefines song length rather than being clipped to
    // the old one. Treating a sole-clip re-record as a fresh anchor
    // matches the "single clip = still drafting" intuition. With ≥2
    // clips, length is committed and subsequent takes stay bounded.
    if (existing.length === 0 && length !== null) {
      context.setSongLength(null)
      length = null
    }
    // Re-route monitor playback through a MediaStreamDestination +
    // hidden <audio> for the duration of the recording. Bypasses the
    // Chrome bug where AudioContext.destination output bleeds into the
    // concurrent getUserMedia capture as audible glitches on the
    // recorded track. Restored to direct output in onStopRecording.
    useMediaStreamOutput()
    if (existing.length > 0) {
      await context.transport.play(existing, length)
    }
    // `latest`, not `untrack` — `isPending` only reports the refresh
    // state (already-initialized signal recomputing), not initial
    // load. `untrack` throws NotReadyError on an UNINITIALIZED+PENDING
    // signal even when `isPending` says false. `latest` returns
    // `undefined` instead. See ../../../solid-pending-bug-repro for
    // the upstream contract mismatch.
    const stream = latest(context.preview.stream)
    logTrace("record-start-stream", { hasStream: stream != null })
    if (stream == null) {
      useDirectOutput()
      return
    }
    const handle = startCapture(stream)
    setCaptureHandle(handle)
    logTrace("record-start-handle", { cellId })

    // Anchor-take: auto-stop at songLength if set.
    if (length !== null) {
      window.setTimeout(() => {
        if (captureHandle() === handle) {
          run("record-stop-auto", onStopRecording)
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
    // Capture is over — autoplay below uses speakers normally.
    useDirectOutput()
    const blob = await handle.stop()
    logTrace("record-stop-blob", { cellId, size: blob.size, type: blob.type })
    if (cellId === null) {
      logTrace("record-stop-abort", { reason: "no cellId" })
      return
    }
    const clip = await blobToClip(cellId, blob)
    logTrace("record-stop-clip-ready", { cellId, duration: clip.duration })
    // Persist the raw blob to OPFS before staging the in-memory clip
    // so a refresh mid-decode can't lose the recording. The manifest
    // update inside saveClipBlob will include the new cellId.
    await context.projects.saveClipBlob(cellId, blob)
    logTrace("record-stop-saved", { cellId })
    context.clips.setClip(cellId, clip)
    if (context.songLength() === null) {
      context.setSongLength(clip.duration)
    }
    // Autoplay: once a recording lands, start the song so the user
    // hears the result without an extra tap.
    const allClips = Object.values(context.clips.clips)
    logTrace("record-stop-autoplay", { clipCount: allClips.length })
    if (allClips.length > 0) {
      await context.transport.play(allClips, context.songLength())
    }
    logTrace("record-stop-complete", { cellId })
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

  /** Toggle "Edit mode" — mounts the contextual HUD's split/append
   *  cycle button. Default sub-mode on entry is `append`; the cycle
   *  button switches to `split` from there. */
  function toggleEdit() {
    const next = context.app.tool === null ? "append" : null
    logAction("set-tool", { tool: next })
    context.setTool(next)
  }

  return (
    <Hud position="bottom-center" orientation="horizontal">
      <Show
        when={context.transport.state() === "stopped"}
        fallback={
          <Hud.Button data-action="stop" onClick={onStopPlayback}>
            <StopIcon />
          </Hud.Button>
        }
      >
        <Hud.Button
          data-action="play"
          disabled={context.clips.cellIds().length === 0}
          onClick={() => run("play", onPlay)}
        >
          <PlayIcon />
        </Hud.Button>
      </Show>
      <Show
        when={captureHandle() !== null}
        fallback={
          // Loading boundary makes the disabled gate read the real
          // stream value: `preview.stream() === null` throws
          // NotReadyError during UNINITIALIZED+PENDING (initial gUM
          // load), which the boundary catches and shows the disabled
          // fallback button. Once the stream commits, the inner button
          // takes over and onClick can safely call into onRecord.
          // `isPending` alone doesn't cover initial load — see
          // ../../../solid-pending-bug-repro.
          <Loading
            fallback={
              <Hud.Button data-action="record-start" disabled>
                <RecordIcon />
              </Hud.Button>
            }
          >
            <Hud.Button
              data-action="record-start"
              disabled={
                selectedCellId(context) === null ||
                isPending(context.preview.stream) ||
                context.preview.stream() === null
              }
              onClick={() => run("record-start", onRecord)}
            >
              <RecordIcon />
            </Hud.Button>
          </Loading>
        }
      >
        <Hud.Button data-action="record-stop" onClick={() => run("record-stop", onStopRecording)}>
          <RecordingActiveIcon />
        </Hud.Button>
      </Show>
      <Hud.Button
        active={context.app.tool !== null}
        data-action="toggle-edit"
        onClick={toggleEdit}
      >
        <EditIcon />
      </Hud.Button>
    </Hud>
  )
}
