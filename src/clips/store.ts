import { createSignal, type Accessor } from "solid-js"
import { disposeClip, type Clip } from "./clip"

const DEFAULT_VOLUME = 1

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
  /** Reactive per-cell volumes (0..1+, default 1). Each cell tracked
   *  independently of clip presence — a slider can pre-set a value
   *  before the recording lands. */
  cellVolume(cellId: string): number
  cellVolumes: Accessor<Record<string, number>>
  setCellVolume(cellId: string, value: number): void
  /** Replace the full volumes map (used on project load). */
  setCellVolumes(next: Record<string, number>): void
}

export function createClipStore(): ClipStore {
  const clips: Record<string, Clip> = {}
  const [cellIds, setCellIds] = createSignal<string[]>([])
  const [cellVolumes, setCellVolumesSignal] = createSignal<Record<string, number>>({})

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
    setCellVolumesSignal(current => {
      if (!(cellId in current)) {
        return current
      }
      const next = { ...current }
      delete next[cellId]
      return next
    })
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
    setCellVolumesSignal({})
  }

  function cellVolume(cellId: string): number {
    return cellVolumes()[cellId] ?? DEFAULT_VOLUME
  }

  function setCellVolume(cellId: string, value: number) {
    setCellVolumesSignal(current => ({ ...current, [cellId]: value }))
  }

  function setCellVolumes(next: Record<string, number>) {
    setCellVolumesSignal(next)
  }

  return {
    cellIds,
    clips,
    setClip,
    clearClip,
    getClip,
    clearAll,
    cellVolume,
    cellVolumes,
    setCellVolume,
    setCellVolumes,
  }
}
