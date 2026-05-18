import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, mockGetUserMedia, test } from "./helpers"

const __dirname = dirname(fileURLToPath(import.meta.url))

test("c2 legacy migrate: phase-2 single-mip project loads + saveCurrent populates cells", async ({ page }) => {
  // Pre-seed OPFS with a legacy project: manifest with cellIds (no
  // cells[]), one bare <cellId>.webm clip blob.
  const legacyClipBytes = readFileSync(resolve(__dirname, "fixtures/sample-1s.webm"))
  const legacyClipB64 = legacyClipBytes.toString("base64")

  await page.goto("about:blank")
  await page.addInitScript((b64: string) => {
    ;(window as unknown as { __preseedClipB64: string }).__preseedClipB64 = b64
  }, legacyClipB64)
  await page.goto("/")
  await page.evaluate(async () => {
    const b64 = (window as unknown as { __preseedClipB64: string }).__preseedClipB64
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    const blob = new Blob([bytes], { type: "video/webm" })

    const root = await navigator.storage.getDirectory()
    const projects = await root.getDirectoryHandle("projects", { create: true })
    const project = await projects.getDirectoryHandle("legacy-project-id", { create: true })
    const clips = await project.getDirectoryHandle("clips", { create: true })

    const manifestHandle = await project.getFileHandle("manifest.json", { create: true })
    const manifestWritable = await manifestHandle.createWritable()
    await manifestWritable.write(
      JSON.stringify({
        id: "legacy-project-id",
        name: "Legacy",
        createdAt: 1_000_000_000_000,
        updatedAt: 1_000_000_000_000,
        layout: { id: "root", kind: "leaf", path: [] },
        songLength: null,
        cellIds: ["legacy-cell"],
      }),
    )
    await manifestWritable.close()

    const clipHandle = await clips.getFileHandle("legacy-cell.webm", { create: true })
    const clipWritable = await clipHandle.createWritable()
    await clipWritable.write(blob)
    await clipWritable.close()

    const currentHandle = await root.getFileHandle("current.json", { create: true })
    const currentWritable = await currentHandle.createWritable()
    await currentWritable.write(JSON.stringify({ id: "legacy-project-id" }))
    await currentWritable.close()
  })

  await mockGetUserMedia(page)
  await page.reload()

  // The legacy clip should load via the legacy fallback path.
  await page.waitForFunction(
    () => Object.keys(window.__appContext?.clips.clips ?? {}).length === 1,
    { timeout: 30_000 },
  )

  // saveCurrent will write the new schema (cells populated) — trigger it.
  await page.evaluate(async () => {
    await window.__appContext?.projects.saveCurrent()
  })

  const cellsAfterSave = await page.evaluate(async () => {
    const projectId = window.__appContext?.projects.activeId()
    if (!projectId) {
      return null
    }
    const root = await navigator.storage.getDirectory()
    const projects = await root.getDirectoryHandle("projects")
    const project = await projects.getDirectoryHandle(projectId)
    const handle = await project.getFileHandle("manifest.json")
    const file = await handle.getFile()
    const manifest = JSON.parse(await file.text())
    return manifest.cells
  })
  expect(cellsAfterSave).toBeInstanceOf(Array)
  expect(cellsAfterSave).toHaveLength(1)
  expect(cellsAfterSave[0]).toHaveProperty("clipId")
  expect(cellsAfterSave[0]).toHaveProperty("cacheWidth")
})
