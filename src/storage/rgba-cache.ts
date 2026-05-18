/**
 * OPFS layout for the C2 raw-RGBA frame cache:
 *   /rgba/<clipId>.bin   frames concatenated, no header
 *
 * Clip IDs are per-recording UUIDs (distinct from cellId) so that
 * re-recording the same cell writes to a fresh file, avoiding the
 * SyncAccessHandle lock held by the previous clip's reader worker.
 * The file is owned by BitmapSource.close()'s deleteRgbaCache call;
 * crash recovery is handled by `garbageCollectRgbaCache(keepSet)` at
 * project-store init, driven by the cells[] records in each project's
 * manifest. `wipeRgbaCache()` stays exported for tests + dev tooling.
 */

export const RGBA_DIR_NAME = "rgba"

async function getRoot(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory()
}

async function getOrCreateRgbaDir(): Promise<FileSystemDirectoryHandle> {
  const root = await getRoot()
  return root.getDirectoryHandle(RGBA_DIR_NAME, { create: true })
}

/** Write the full concatenated RGBA bytes for a clip, replacing any
 *  existing cache. Used at clip-creation time (one-shot). */
export async function writeRgbaCache(clipId: string, bytes: Uint8Array): Promise<void> {
  const dir = await getOrCreateRgbaDir()
  const handle = await dir.getFileHandle(`${clipId}.bin`, { create: true })
  const writable = await handle.createWritable({ keepExistingData: false })
  try {
    // Pass a Blob to match the writeClipBlob pattern in
    // src/storage/opfs.ts. The `as BlobPart` cast sidesteps the
    // Uint8Array<ArrayBufferLike> vs ArrayBuffer<ArrayBuffer>
    // friction in the current TS DOM lib.
    await writable.write(new Blob([bytes as BlobPart]))
    await writable.close()
  } catch (error) {
    await writable.abort().catch(() => {})
    throw error
  }
}

/** Delete the clip's rgba cache file. Safe to call when the file
 *  doesn't exist. */
export async function deleteRgbaCache(clipId: string): Promise<void> {
  try {
    const root = await getRoot()
    const dir = await root.getDirectoryHandle(RGBA_DIR_NAME, { create: false })
    await dir.removeEntry(`${clipId}.bin`)
  } catch (error) {
    // Already-clean cases (directory or file missing) are the
    // expected silent path. Anything else (permissions, quota)
    // should surface.
    if (error instanceof DOMException && error.name === "NotFoundError") {
      return
    }
    throw error
  }
}

/** Test/dev helper: does the cache file exist for this clip? Treats
 *  any error (NotFoundError, permissions, etc.) as "no" — callers
 *  use this for diagnostic checks, not for app-logic decisions. */
export async function rgbaCacheExists(clipId: string): Promise<boolean> {
  try {
    const root = await getRoot()
    const dir = await root.getDirectoryHandle(RGBA_DIR_NAME, { create: false })
    await dir.getFileHandle(`${clipId}.bin`, { create: false })
    return true
  } catch {
    return false
  }
}

/** Remove all rgba cache files. Called at project-store init to
 *  drop orphans from previous sessions (page closed mid-session
 *  before BitmapSource.close() fired). Phase 2 regenerates all
 *  rgba files from persisted WebM blobs on project load, so any
 *  pre-existing file is stale by construction. */
export async function wipeRgbaCache(): Promise<void> {
  try {
    const root = await getRoot()
    await root.removeEntry(RGBA_DIR_NAME, { recursive: true })
  } catch (error) {
    // Directory doesn't exist yet — clean slate.
    if (error instanceof DOMException && error.name === "NotFoundError") {
      return
    }
    throw error
  }
}

/** Delete every rgba cache file whose clipId is NOT in `keep`.
 *  Used at app startup once the projects manifest list has been read,
 *  so we can drop orphan files (from crashes, deleted projects, manual
 *  fiddling) without nuking the cached frames for clips referenced by
 *  any current project's manifest.
 *
 *  Safer than the phase 2 `wipeRgbaCache()` hammer because the hot-path
 *  reuse (phase 3 Task 5) only works if the cache file survives to the
 *  next session — so we must NOT delete files for clips a manifest
 *  still references.
 *
 *  Errors per-file are swallowed (best-effort GC); only catastrophic
 *  errors (root dir unreadable) propagate. */
export async function garbageCollectRgbaCache(keep: Set<string>): Promise<void> {
  let dir: FileSystemDirectoryHandle
  try {
    const root = await getRoot()
    dir = await root.getDirectoryHandle(RGBA_DIR_NAME, { create: false })
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      return
    }
    throw error
  }
  for await (const [name, entry] of dir.entries()) {
    if (entry.kind !== "file") {
      continue
    }
    // File names are `<clipId>.bin`. Strip the suffix to compare.
    if (!name.endsWith(".bin")) {
      continue
    }
    const clipId = name.slice(0, -".bin".length)
    if (keep.has(clipId)) {
      continue
    }
    try {
      await dir.removeEntry(name)
    } catch {
      // Best-effort; another tab or a worker may have removed it
      // already.
    }
  }
}
