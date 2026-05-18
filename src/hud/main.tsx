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
import { startCapture, type CaptureSession } from "../media/capture"
import { logAction, logTrace, run, selectedCellId } from "../utils"
import { Hud } from "./hud"

export function Main() {
  const context = useContext(Context)!
  const [captureHandle, setCaptureHandle] = createSignal<CaptureSession | null>(null)

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
    const handle = await startCapture(stream)
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
    const result = await handle.stop()
    logTrace("record-stop-result", {
      cellId,
      canonicalSize: result.canonicalBlob.size,
      mipSize: result.mipBlob.size,
      duration: result.durationSeconds,
      frames: result.frameCount,
      codec: result.videoCodec,
    })
    if (cellId === null) {
      logTrace("record-stop-abort", { reason: "no cellId" })
      return
    }
    // Build the clip from the MIP blob — bitmap pipeline always reads
    // the mip; the 720p canonical is reserved for export / fullscreen.
    const clip = await blobToClip(cellId, result.mipBlob)
    logTrace("record-stop-clip-ready", {
      cellId,
      clipId: clip.clipId,
      duration: clip.duration,
      cacheMeta: clip.videoCacheMetadata,
    })
    // Persist both blobs in parallel before staging the clip so a
    // mid-decode refresh can't lose either file. The manifest update
    // (which gets the CellRecord with clipId + cache metadata) follows
    // via setClip → save effect, picking up clip.clipId + clip.videoCacheMetadata.
    //
    // If either save fails, the other may have committed — clean up
    // both before rethrowing so we don't leave an orphan blob with no
    // matching manifest entry. The clips dir has no GC pass; only the
    // rgba cache does.
    try {
      await Promise.all([
        context.projects.saveClipBlob(cellId, "720p", result.canonicalBlob),
        context.projects.saveClipBlob(cellId, "270p", result.mipBlob),
      ])
    } catch (error) {
      logTrace("record-stop-save-failed", {
        cellId,
        error: error instanceof Error ? error.message : String(error),
      })
      await Promise.all([
        context.projects.removeClipBlob(cellId).catch(() => {}),
      ])
      throw error
    }
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
