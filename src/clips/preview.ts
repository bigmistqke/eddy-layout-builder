import { createSignal } from "solid-js"

export interface PreviewState {
  /** Cell id currently showing the live camera, or null. */
  activeCellId(): string | null
  /** The video element to sample. Always returns the same element. */
  element: HTMLVideoElement
  /** Start showing `stream` on `cellId`. Resolves when first frame is rendered. */
  start(cellId: string, stream: MediaStream): Promise<void>
  /** Stop preview. */
  stop(): void
}

export function createPreview(): PreviewState {
  const element = document.createElement("video")
  element.muted = true
  element.playsInline = true
  element.autoplay = true

  const [activeCellId, setActiveCellId] = createSignal<string | null>(null)

  async function start(cellId: string, stream: MediaStream): Promise<void> {
    element.srcObject = stream
    setActiveCellId(cellId)
    const { promise, resolve } = Promise.withResolvers<void>()
    const onLoaded = () => {
      element.removeEventListener("loadedmetadata", onLoaded)
      resolve()
    }
    element.addEventListener("loadedmetadata", onLoaded)
    await promise
    await element.play().catch(() => {
      // autoplay should succeed under fake-media flag
    })
  }

  function stop() {
    element.srcObject = null
    setActiveCellId(null)
  }

  return { activeCellId, element, start, stop }
}
