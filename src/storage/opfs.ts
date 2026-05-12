import type { Node } from "../types"

/**
 * OPFS layout:
 *   /current.json                          { id }
 *   /projects/<id>/manifest.json
 *   /projects/<id>/clips/<cellId>.webm
 *
 * Pure async — no Solid signals. Callers stage IO; reactivity lives in
 * the projects store one layer above.
 */

export interface ProjectManifest {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  layout: Node
  songLength: number | null
  /** Cell ids that have a blob on disk under clips/. */
  cellIds: string[]
  /** Per-cell volume (0..1+, default 1). Absent entries → default.
   *  Optional for backward compat with pre-v2.audio manifests. */
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

export async function readClipBlob(id: string, cellId: string): Promise<Blob | null> {
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
    const handle = await clips.getFileHandle(`${cellId}.webm`)
    return handle.getFile()
  } catch {
    return null
  }
}

export async function writeClipBlob(
  id: string,
  cellId: string,
  blob: Blob,
): Promise<void> {
  const dir = await getProjectDir(id)
  const clips = await getOrCreateDir(dir, CLIPS_DIR)
  const handle = await clips.getFileHandle(`${cellId}.webm`, { create: true })
  const writable = await handle.createWritable()
  await writable.write(blob)
  await writable.close()
}

export async function deleteClipBlob(id: string, cellId: string): Promise<void> {
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
    await clips.removeEntry(`${cellId}.webm`)
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
