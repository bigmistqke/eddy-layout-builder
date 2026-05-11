import { createSignal } from "solid-js"
import { disposeClip, type Clip } from "./clip"

export interface ClipStore {
  /** Reactive set of cell ids with clips. Reading this in a reactive
   *  scope tracks membership changes. Iterate via `cellIds()`. */
  cellIds(): string[]
  /** All clips, indexed by cell id. Plain — NOT a Solid store proxy.
   *  Web Audio / WebCodecs APIs reject proxied host objects, so clips
   *  live outside the reactive layer and reactivity is keyed-only. */
  clips: Record<string, Clip>
  setClip(cellId: string, clip: Clip): void
  clearClip(cellId: string): void
  getClip(cellId: string): Clip | undefined
  clearAll(): void
}

export function createClipStore(): ClipStore {
  const clips: Record<string, Clip> = {}
  const [cellIds, setCellIds] = createSignal<string[]>([])

  function setClip(cellId: string, clip: Clip) {
    const existing = clips[cellId]
    if (existing !== undefined) {
      disposeClip(existing)
    }
    clips[cellId] = clip
    if (!cellIds().includes(cellId)) {
      setCellIds([...cellIds(), cellId])
    }
  }

  function clearClip(cellId: string) {
    const existing = clips[cellId]
    if (existing === undefined) {
      return
    }
    disposeClip(existing)
    delete clips[cellId]
    setCellIds(cellIds().filter(id => id !== cellId))
  }

  function getClip(cellId: string): Clip | undefined {
    return clips[cellId]
  }

  function clearAll() {
    for (const cellId of Object.keys(clips)) {
      disposeClip(clips[cellId])
      delete clips[cellId]
    }
    setCellIds([])
  }

  return {
    cellIds,
    clips,
    setClip,
    clearClip,
    getClip,
    clearAll,
  }
}
