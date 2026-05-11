import { createStore } from "solid-js"
import { disposeClip, type Clip } from "./clip"

export interface ClipStore {
  clips: Record<string, Clip>
  setClip(cellId: string, clip: Clip): void
  clearClip(cellId: string): void
  getClip(cellId: string): Clip | undefined
  clearAll(): void
}

export function createClipStore(): ClipStore {
  const [clips, setClips] = createStore<Record<string, Clip>>({})

  function setClip(cellId: string, clip: Clip) {
    setClips(draft => {
      const existing = draft[cellId]
      if (existing !== undefined) {
        disposeClip(existing)
      }
      draft[cellId] = clip
    })
  }

  function clearClip(cellId: string) {
    setClips(draft => {
      const existing = draft[cellId]
      if (existing !== undefined) {
        disposeClip(existing)
        delete draft[cellId]
      }
    })
  }

  function getClip(cellId: string): Clip | undefined {
    return clips[cellId]
  }

  function clearAll() {
    setClips(draft => {
      for (const cellId of Object.keys(draft)) {
        disposeClip(draft[cellId])
        delete draft[cellId]
      }
    })
  }

  return {
    get clips() {
      return clips
    },
    setClip,
    clearClip,
    getClip,
    clearAll,
  }
}
