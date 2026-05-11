import { createSignal, untrack, type Accessor } from "solid-js"

export interface Preview {
  /** Reactive — the MediaStream when the camera is enabled, else null. */
  stream: Accessor<MediaStream | null>
  /** Persistent <video> element bound to the camera stream. Used by
   *  the renderer as a texture source. Always the same instance. */
  element: HTMLVideoElement
  /** Cell id that's currently the live-preview target, or null. The
   *  renderer paints `element` into this cell during render. */
  targetCellId: Accessor<string | null>
  setTargetCellId(cellId: string | null): void
  /** Acquire the camera (idempotent). Resolves when video metadata is loaded. */
  enable(): Promise<void>
  /** Release the camera. Stops all tracks. */
  disable(): void
}

export function createPreview(): Preview {
  const element = document.createElement("video")
  element.muted = true
  element.playsInline = true
  element.autoplay = true

  const [stream, setStream] = createSignal<MediaStream | null>(null)
  const [targetCellId, setTargetCellId] = createSignal<string | null>(null)

  async function enable() {
    // Idempotent — early-return if already enabled. Read untracked
    // because enable() is called from event handlers AND from a
    // createEffect's apply (Main's tool-mode watcher); the apply path
    // would otherwise trip STRICT_READ_UNTRACKED.
    if (untrack(stream) !== null) {
      return
    }
    const next = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
    element.srcObject = next
    setStream(next)
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
  }

  function disable() {
    const current = stream()
    if (current === null) {
      return
    }
    for (const track of current.getTracks()) {
      track.stop()
    }
    element.srcObject = null
    setStream(null)
    setTargetCellId(null)
  }

  return { stream, element, targetCellId, setTargetCellId, enable, disable }
}
