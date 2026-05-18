import type { Node } from "../types"

/**
 * OPFS layout:
 *   /current.json                                  { id }
 *   /projects/<id>/manifest.json
 *   /projects/<id>/clips/<cellId>.720p.webm        Canonical 720p AV1 + opus
 *   /projects/<id>/clips/<cellId>.270p.webm        Playback mip 270p AV1 + opus
 *   /projects/<id>/clips/<cellId>.webm             Legacy single-mip (pre-phase 3)
 *
 * Pure async — no Solid signals. Callers stage IO; reactivity lives in
 * the projects store one layer above.
 */

/** Two recorded mips per clip. Legacy single-mip clips don't carry
 *  this and are read via the bare `<cellId>.webm` path. */
export type Mip = "720p" | "270p"

/** Per-cell persisted record. Carries the clipId (used to key the
 *  rgba cache so it survives session reopen) and cache metadata so
 *  the bitmap-source hot path can spawn its reader without
 *  re-demuxing the mip WebM. */
export interface CellRecord {
  cellId: string
  clipId: string
  cacheWidth: number
  cacheHeight: number
  cacheFrames: number
  cacheSourceFps: number
}

export interface ProjectManifest {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  layout: Node
  songLength: number | null
  /** Phase 3+: per-cell records with clipId + cache metadata. Absent
   *  on pre-phase-3 manifests; migration is handled in the projects
   *  store (single-mip blobs treated as 270p mip, fresh clipId
   *  generated on first load). */
  cells?: CellRecord[]
  /** Legacy field — list of cell ids with a blob on disk. Kept for
   *  back-compat reading; new writes populate `cells` and derive this
   *  from it. */
  cellIds: string[]
  /** Per-cell volume (0..1+, default 1). */
  cellVolumes?: Record<string, number>
}

const PROJECTS_DIR = "projects"
const CLIPS_DIR = "clips"
const MANIFEST_FILE = "manifest.json"
const CURRENT_FILE = "current.json"

async function getRoot(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory()
}

async function getOrCreateDir(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemDirectoryHandle> {
  return parent.getDirectoryHandle(name, { create: true })
}

async function tryGetDir(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await parent.getDirectoryHandle(name)
  } catch {
    return null
  }
}

async function readJson<T>(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<T | null> {
  try {
    const handle = await parent.getFileHandle(name)
    const file = await handle.getFile()
    return JSON.parse(await file.text()) as T
  } catch {
    return null
  }
}

async function writeJson<T>(
  parent: FileSystemDirectoryHandle,
  name: string,
  value: T,
): Promise<void> {
  const handle = await parent.getFileHandle(name, { create: true })
  const writable = await handle.createWritable()
  await writable.write(JSON.stringify(value))
  await writable.close()
}

async function getProjectDir(id: string): Promise<FileSystemDirectoryHandle> {
  const projects = await getOrCreateDir(await getRoot(), PROJECTS_DIR)
  return getOrCreateDir(projects, id)
}

export async function listProjects(): Promise<ProjectManifest[]> {
  const root = await getRoot()
  const projects = await tryGetDir(root, PROJECTS_DIR)
  if (projects === null) {
    return []
  }
  const out: ProjectManifest[] = []
  for await (const [, entry] of projects.entries()) {
    if (entry.kind !== "directory") {
      continue
    }
    const manifest = await readJson<ProjectManifest>(entry, MANIFEST_FILE)
    if (manifest !== null) {
      out.push(manifest)
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt)
  return out
}

export async function readManifest(id: string): Promise<ProjectManifest | null> {
  const projects = await tryGetDir(await getRoot(), PROJECTS_DIR)
  if (projects === null) {
    return null
  }
  const dir = await tryGetDir(projects, id)
  if (dir === null) {
    return null
  }
  return readJson<ProjectManifest>(dir, MANIFEST_FILE)
}

export async function writeManifest(manifest: ProjectManifest): Promise<void> {
  const dir = await getProjectDir(manifest.id)
  await writeJson(dir, MANIFEST_FILE, manifest)
}

function clipFileName(cellId: string, mip: Mip | null): string {
  return mip === null ? `${cellId}.webm` : `${cellId}.${mip}.webm`
}

/** Read a clip blob. Pass `mip` to read a phase-3 mip-specific file;
 *  pass `null` to read a legacy single-mip blob. Returns null if not
 *  found. */
export async function readClipBlob(
  id: string,
  cellId: string,
  mip: Mip | null,
): Promise<Blob | null> {
  const projects = await tryGetDir(await getRoot(), PROJECTS_DIR)
  if (projects === null) {
    return null
  }
  const dir = await tryGetDir(projects, id)
  if (dir === null) {
    return null
  }
  const clips = await tryGetDir(dir, CLIPS_DIR)
  if (clips === null) {
    return null
  }
  try {
    const handle = await clips.getFileHandle(clipFileName(cellId, mip))
    return handle.getFile()
  } catch {
    return null
  }
}

/** Write a clip blob to one of the mip slots. */
export async function writeClipBlob(
  id: string,
  cellId: string,
  mip: Mip,
  blob: Blob,
): Promise<void> {
  const dir = await getProjectDir(id)
  const clips = await getOrCreateDir(dir, CLIPS_DIR)
  const handle = await clips.getFileHandle(clipFileName(cellId, mip), { create: true })
  const writable = await handle.createWritable()
  await writable.write(blob)
  await writable.close()
}

/** Delete one mip's blob. Silently no-ops if the file isn't there. */
export async function deleteClipBlob(
  id: string,
  cellId: string,
  mip: Mip | null,
): Promise<void> {
  const projects = await tryGetDir(await getRoot(), PROJECTS_DIR)
  if (projects === null) {
    return
  }
  const dir = await tryGetDir(projects, id)
  if (dir === null) {
    return
  }
  const clips = await tryGetDir(dir, CLIPS_DIR)
  if (clips === null) {
    return
  }
  try {
    await clips.removeEntry(clipFileName(cellId, mip))
  } catch {
    // Already gone.
  }
}

export async function deleteProject(id: string): Promise<void> {
  const projects = await tryGetDir(await getRoot(), PROJECTS_DIR)
  if (projects === null) {
    return
  }
  try {
    await projects.removeEntry(id, { recursive: true })
  } catch {
    // Already gone.
  }
}

export async function getCurrentProjectId(): Promise<string | null> {
  const pointer = await readJson<{ id: string }>(await getRoot(), CURRENT_FILE)
  return pointer === null ? null : pointer.id
}

export async function setCurrentProjectId(id: string): Promise<void> {
  await writeJson(await getRoot(), CURRENT_FILE, { id })
}
