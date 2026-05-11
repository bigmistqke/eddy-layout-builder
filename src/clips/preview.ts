import { createSignal, isPending, untrack, type Accessor } from "solid-js"

export interface Preview {
  /** Writable async signal. Reading triggers the underlying
   *  `getUserMedia` request lazily; the first reactive read kicks
   *  acquisition off, subsequent reads return the resolved stream.
   *  Throws `NotReadyError` from event handlers while pending — gate
   *  consumers on `isLoading()` (e.g. disable buttons) so they never
   *  read while pending. */
  stream: Accessor<MediaStream | null>
  /** True while the camera is acquiring. Derived from `isPending(stream)`. */
  isLoading: Accessor<boolean>
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
    const next = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
    element.srcObject = next
    const { promise, resolve } = Promise.withResolvers<void>()
    const onLoaded = () => {
      element.removeEventListener("loadedmetadata", onLoaded)
      resolve()
    }
    element.addEventListener("loadedmetadata", onLoaded)
    await promise
    await element.play().catch(() => {
      // autoplay should succeed under the autoplay-policy flag
    })
    return next
  })

  const isLoading = () => isPending(stream)

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

  return { stream, isLoading, element, disable }
}
