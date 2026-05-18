import { createMemo, createSignal, untrack, type Accessor } from "solid-js"
import { blobToClip, type Clip } from "../clips/clip"
import type { ClipStore } from "../clips/store"
import {
  deleteClipBlob,
  deleteProject as deleteProjectOnDisk,
  getCurrentProjectId,
  listProjects,
  readClipBlob,
  readManifest,
  setCurrentProjectId,
  writeClipBlob,
  writeManifest,
  type CellRecord,
  type Mip,
  type ProjectManifest,
} from "../storage/opfs"
import { garbageCollectRgbaCache, deleteRgbaCache } from "../storage/rgba-cache"
import type { Node } from "../types"
import { createEntity } from "../utils"

export interface ProjectsStoreDeps {
  clips: ClipStore
  /** Replace the in-memory layout tree. */
  setLayout(layout: Node): void
  /** Replace the in-memory song length. */
  setSongLength(value: number | null): void
  /** Reset the selection — called after a project swap so paths from
   *  the previous layout can't resolve against the new one. */
  resetSelection(): void
  /** Read the current layout (untracked) for serialisation. */
  readLayout(): Node
  /** Read the current song length (untracked) for serialisation. */
  readSongLength(): number | null
}

export interface ProjectsStore {
  list: Accessor<ProjectManifest[]>
  activeId: Accessor<string | null>
  active: Accessor<ProjectManifest | null>
  /** True while a project is being loaded from OPFS (init or open).
   *  The auto-save effect reads this to skip the redundant save that
   *  the load itself would otherwise trigger. */
  isLoading: Accessor<boolean>
  /** Boot: load the project list, switch to the active id (or adopt
   *  the in-memory state if OPFS is empty). Idempotent — call once. */
  init(): Promise<void>
  /** Allocate a fresh project, switch to it, and write its manifest. */
  createProject(): Promise<void>
  openProject(id: string): Promise<void>
  renameProject(id: string, name: string): Promise<void>
  deleteProject(id: string): Promise<void>
  /** Persist the current project's manifest snapshot. Usually called
   *  by the auto-save effect; safe to call explicitly. */
  saveCurrent(): Promise<void>
  /** Phase 3: persist one mip of a recorded clip. Called twice per
   *  record-stop (once for 720p, once for 270p). */
  saveClipBlob(cellId: string, mip: Mip, blob: Blob): Promise<void>
  /** Remove all mips + the rgba cache for a clip. */
  removeClipBlob(cellId: string): Promise<void>
}

function nextUntitledName(existing: ProjectManifest[]): string {
  const used = new Set(existing.map(p => p.name))
  for (let i = 1; ; i++) {
    const candidate = `Untitled ${i}`
    if (!used.has(candidate)) {
      return candidate
    }
  }
}

/** Build CellRecord[] from the current in-memory clip state. */
function cellsFromClips(clipStore: ClipStore): CellRecord[] {
  return untrack(clipStore.cellIds)
    .map(cellId => {
      const clip = clipStore.clips[cellId] as Clip | undefined
      if (clip === undefined) {
        return null
      }
      return {
        cellId,
        clipId: clip.clipId,
        cacheWidth: clip.videoCacheMetadata.width,
        cacheHeight: clip.videoCacheMetadata.height,
        cacheFrames: clip.videoCacheMetadata.totalFrames,
        cacheSourceFps: clip.videoCacheMetadata.sourceFps,
      } satisfies CellRecord
    })
    .filter((c): c is CellRecord => c !== null)
}

export function createProjectsStore(deps: ProjectsStoreDeps): ProjectsStore {
  const [list, setList] = createSignal<ProjectManifest[]>([])
  const [activeId, setActiveId] = createSignal<string | null>(null)
  const [isLoading, setIsLoading] = createSignal(false)

  const active = createMemo(() => {
    const id = activeId()
    if (id === null) {
      return null
    }
    return list().find(p => p.id === id) ?? null
  })

  function snapshot(name: string, base: ProjectManifest | null): ProjectManifest {
    const now = Date.now()
    const cells = cellsFromClips(deps.clips)
    return {
      id: base?.id ?? crypto.randomUUID(),
      name,
      createdAt: base?.createdAt ?? now,
      updatedAt: now,
      layout: deps.readLayout(),
      songLength: deps.readSongLength(),
      cells,
      cellIds: cells.map(c => c.cellId),
      cellVolumes: { ...untrack(deps.clips.cellVolumes) },
    }
  }

  function upsertInList(manifest: ProjectManifest) {
    setList(current => {
      const others = current.filter(p => p.id !== manifest.id)
      return [manifest, ...others]
    })
  }

  async function loadProjectIntoState(manifest: ProjectManifest) {
    setIsLoading(true)
    try {
      deps.clips.clearAll()
      deps.setLayout(manifest.layout)
      deps.setSongLength(manifest.songLength)
      deps.clips.setCellVolumes(manifest.cellVolumes ?? {})
      deps.resetSelection()

      // Build a quick lookup of CellRecord by cellId (for hot-path
      // metadata). Legacy manifests have no `cells`; we treat them
      // as cold-only.
      const recordByCellId = new Map<string, CellRecord>()
      for (const record of manifest.cells ?? []) {
        recordByCellId.set(record.cellId, record)
      }
      for (const cellId of manifest.cellIds) {
        // Prefer the 270p mip (phase 3+); fall back to legacy bare
        // <cellId>.webm. The 720p file is canonical-only — bitmap
        // pipeline doesn't decode it.
        const blob =
          (await readClipBlob(manifest.id, cellId, "270p")) ??
          (await readClipBlob(manifest.id, cellId, null))
        if (blob === null) {
          continue
        }
        const record = recordByCellId.get(cellId)
        const clip = await blobToClip(cellId, blob, {
          persistedClipId: record?.clipId,
          hotMetadata: record === undefined
            ? undefined
            : {
                width: record.cacheWidth,
                height: record.cacheHeight,
                totalFrames: record.cacheFrames,
                sourceFps: record.cacheSourceFps,
              },
        })
        deps.clips.setClip(cellId, clip)
      }
    } finally {
      setIsLoading(false)
    }
  }

  async function init() {
    const existing = await listProjects()
    setList(existing)

    // Build the keep set BEFORE GC so we don't delete files for clips
    // we're about to load. Includes EVERY clipId across EVERY project
    // (not just the active one) — opening project B shouldn't blow
    // away project A's cached frames.
    const keep = new Set<string>()
    for (const manifest of existing) {
      for (const record of manifest.cells ?? []) {
        keep.add(record.clipId)
      }
    }
    await garbageCollectRgbaCache(keep)

    const currentId = await getCurrentProjectId()
    const target =
      (currentId !== null ? existing.find(p => p.id === currentId) : undefined) ?? existing[0]
    if (target !== undefined) {
      setActiveId(target.id)
      await setCurrentProjectId(target.id)
      await loadProjectIntoState(target)
      return
    }
    setIsLoading(true)
    try {
      // Mirror snapshot()'s invariant: cellIds derives from cells.
      const cells = cellsFromClips(deps.clips)
      const manifest: ProjectManifest = {
        id: crypto.randomUUID(),
        name: nextUntitledName(existing),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        layout: deps.readLayout(),
        songLength: deps.readSongLength(),
        cells,
        cellIds: cells.map(c => c.cellId),
      }
      setActiveId(manifest.id)
      upsertInList(manifest)
      await writeManifest(manifest)
      await setCurrentProjectId(manifest.id)
    } finally {
      setIsLoading(false)
    }
  }

  async function createProject() {
    setIsLoading(true)
    try {
      const name = nextUntitledName(list())
      const layout = createEntity()
      const manifest: ProjectManifest = {
        id: crypto.randomUUID(),
        name,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        layout,
        songLength: null,
        cells: [],
        cellIds: [],
      }
      deps.clips.clearAll()
      deps.setLayout(layout)
      deps.setSongLength(null)
      deps.resetSelection()
      setActiveId(manifest.id)
      upsertInList(manifest)
      await writeManifest(manifest)
      await setCurrentProjectId(manifest.id)
    } finally {
      setIsLoading(false)
    }
  }

  async function openProject(id: string) {
    if (id === activeId()) {
      return
    }
    const manifest = await readManifest(id)
    if (manifest === null) {
      return
    }
    setActiveId(id)
    await setCurrentProjectId(id)
    await loadProjectIntoState(manifest)
  }

  async function renameProject(id: string, name: string) {
    const manifest = await readManifest(id)
    if (manifest === null) {
      return
    }
    const next: ProjectManifest = { ...manifest, name, updatedAt: Date.now() }
    upsertInList(next)
    await writeManifest(next)
  }

  async function deleteProject(id: string) {
    // Read manifest first so we know which clip files + rgba caches
    // belong to this project. Then delete clip + rgba files
    // explicitly (the OPFS deleteProjectOnDisk handles the project
    // directory; the rgba files live in /rgba/, NOT under the project).
    const manifest = await readManifest(id)
    if (manifest !== null) {
      for (const record of manifest.cells ?? []) {
        await deleteRgbaCache(record.clipId).catch(() => {})
      }
    }
    await deleteProjectOnDisk(id)
    setList(current => current.filter(p => p.id !== id))
    if (activeId() !== id) {
      return
    }
    const remaining = list()
    if (remaining.length === 0) {
      setActiveId(null)
      await createProject()
      return
    }
    await openProject(remaining[0].id)
  }

  async function saveCurrent() {
    const current = untrack(active)
    if (current === null) {
      return
    }
    const next = snapshot(current.name, current)
    upsertInList(next)
    await writeManifest(next)
  }

  async function saveClipBlob(cellId: string, mip: Mip, blob: Blob) {
    const id = activeId()
    if (id === null) {
      return
    }
    await writeClipBlob(id, cellId, mip, blob)
  }

  async function removeClipBlob(cellId: string) {
    const id = activeId()
    if (id === null) {
      return
    }
    await deleteClipBlob(id, cellId, "720p")
    await deleteClipBlob(id, cellId, "270p")
    await deleteClipBlob(id, cellId, null)
  }

  return {
    list,
    activeId,
    active,
    isLoading,
    init,
    createProject,
    openProject,
    renameProject,
    deleteProject,
    saveCurrent,
    saveClipBlob,
    removeClipBlob,
  }
}
