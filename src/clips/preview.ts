import { createSignal, untrack, type Accessor } from "solid-js"
import { logError } from "../utils"

export interface Preview {
  /** Writable async signal. Reading triggers the underlying
   *  `getUserMedia` request lazily; the first reactive read kicks
   *  acquisition off, subsequent reads return the resolved stream.
   *  Throws `NotReadyError` from event handlers while pending — gate
   *  consumers on `isPending(preview.stream)` (e.g. disable buttons)
   *  so they never read while pending. */
  stream: Accessor<MediaStream | null>
  /** Persistent <video> element bound to the camera stream. Used by
   *  the renderer as a texture source. Always the same instance. */
  element: HTMLVideoElement
  /** Release the camera. */
  disable(): void
}

export function createPreview(): Preview {
  const element = document.createElement("video")
  element.muted = true
  element.playsInline = true
  element.autoplay = true

  // Function-form createSignal: writable async derived signal. The
  // compute runs once on first reactive read (no tracked deps), so the
  // gUM fires when something needs the stream. setStream(null) lets
  // disable() reset back to an idle state.
  const [stream, setStream] = createSignal<MediaStream | null>(async () => {
    try {
      const next = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      // Strip the audio track from the preview element's srcObject so
      // Android Chrome treats it as autoplayable (an HTMLVideoElement
      // with audio in its source is blocked by the autoplay policy
      // even when `muted = true`). The full stream — including audio —
      // is still returned by the signal, so capture and monitor routing
      // are unaffected.
      element.srcObject = new MediaStream(next.getVideoTracks())
      const { promise, resolve } = Promise.withResolvers<void>()
      const controller = new AbortController()
      element.addEventListener(
        "loadedmetadata",
        () => {
          controller.abort()
          resolve()
        },
        controller,
      )
      await promise
      await element.play()
      return next
    } catch (error) {
      logError("preview-getusermedia", error)
      return null
    }
  })

  function disable() {
    let current: MediaStream | null = null
    try {
      current = untrack(stream)
    } catch {
      // Still pending — nothing acquired yet.
    }
    if (current === null) {
      return
    }
    for (const track of current.getTracks()) {
      track.stop()
    }
    element.srcObject = null
    setStream(null)
  }

  return { stream, element, disable }
}
