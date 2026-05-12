import { createMemo, createSignal, untrack, type Accessor } from "solid-js"
import { blobToClip } from "../clips/clip"
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
  type ProjectManifest,
} from "../storage/opfs"
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
  /** Write a recorded blob to disk. Manifest update follows reactively
   *  once the matching `clips.setClip` lands. */
  saveClipBlob(cellId: string, blob: Blob): Promise<void>
  /** Remove a clip blob from disk. */
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
    return {
      id: base?.id ?? crypto.randomUUID(),
      name,
      createdAt: base?.createdAt ?? now,
      updatedAt: now,
      layout: deps.readLayout(),
      songLength: deps.readSongLength(),
      cellIds: untrack(deps.clips.cellIds),
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
      for (const cellId of manifest.cellIds) {
        const blob = await readClipBlob(manifest.id, cellId)
        if (blob === null) {
          continue
        }
        const clip = await blobToClip(cellId, blob)
        deps.clips.setClip(cellId, clip)
      }
    } finally {
      setIsLoading(false)
    }
  }

  async function init() {
    const existing = await listProjects()
    setList(existing)
    const currentId = await getCurrentProjectId()
    const target =
      (currentId !== null ? existing.find(p => p.id === currentId) : undefined) ?? existing[0]
    if (target !== undefined) {
      setActiveId(target.id)
      await setCurrentProjectId(target.id)
      await loadProjectIntoState(target)
      return
    }
    // OPFS empty: adopt the current in-memory state as the first
    // project. Avoids replacing the freshly-mounted layout entity with
    // a different one — tests captured against initial state would
    // otherwise race the async init.
    setIsLoading(true)
    try {
      const manifest: ProjectManifest = {
        id: crypto.randomUUID(),
        name: nextUntitledName(existing),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        layout: deps.readLayout(),
        songLength: deps.readSongLength(),
        cellIds: untrack(deps.clips.cellIds),
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
    await deleteProjectOnDisk(id)
    setList(current => current.filter(p => p.id !== id))
    if (activeId() !== id) {
      return
    }
    // The active project was just deleted — fall back to the most
    // recent remaining one, or bootstrap a fresh project if none left.
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

  async function saveClipBlob(cellId: string, blob: Blob) {
    const id = activeId()
    if (id === null) {
      return
    }
    await writeClipBlob(id, cellId, blob)
  }

  async function removeClipBlob(cellId: string) {
    const id = activeId()
    if (id === null) {
      return
    }
    await deleteClipBlob(id, cellId)
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
