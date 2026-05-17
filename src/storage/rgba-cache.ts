/**
 * OPFS layout for the C2 raw-RGBA frame cache:
 *   /rgba/<cellId>.bin   frames concatenated, no header
 *
 * Cell IDs are UUIDs — flat namespacing is safe across projects.
 * Project deletion iterates manifest.cellIds and calls
 * `deleteRgbaCache(cellId)` for each.
 */

export const RGBA_DIR_NAME = "rgba"

async function getRoot(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory()
}

async function getOrCreateRgbaDir(): Promise<FileSystemDirectoryHandle> {
  const root = await getRoot()
  return root.getDirectoryHandle(RGBA_DIR_NAME, { create: true })
}

/** Write the full concatenated RGBA bytes for a cell, replacing any
 *  existing cache. Used at clip-creation time (one-shot). */
export async function writeRgbaCache(cellId: string, bytes: Uint8Array): Promise<void> {
  const dir = await getOrCreateRgbaDir()
  const handle = await dir.getFileHandle(`${cellId}.bin`, { create: true })
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

/** Delete the cell's rgba cache file. Safe to call when the file
 *  doesn't exist. */
export async function deleteRgbaCache(cellId: string): Promise<void> {
  try {
    const root = await getRoot()
    const dir = await root.getDirectoryHandle(RGBA_DIR_NAME, { create: false })
    await dir.removeEntry(`${cellId}.bin`)
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

/** Test/dev helper: does the cache file exist for this cell? Treats
 *  any error (NotFoundError, permissions, etc.) as "no" — callers
 *  use this for diagnostic checks, not for app-logic decisions. */
export async function rgbaCacheExists(cellId: string): Promise<boolean> {
  try {
    const root = await getRoot()
    const dir = await root.getDirectoryHandle(RGBA_DIR_NAME, { create: false })
    await dir.getFileHandle(`${cellId}.bin`, { create: false })
    return true
  } catch {
    return false
  }
}
