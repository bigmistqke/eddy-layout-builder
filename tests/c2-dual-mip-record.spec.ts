import { expect, mockGetUserMedia, test } from "./helpers"

test("c2 dual mip: recording creates both 720p and 270p webm files", async ({ page }) => {
  await mockGetUserMedia(page)
  await page.goto("/")

  await page.locator('[data-action="record-start"]').click()
  await page.waitForFunction(() => window.__appContext?.previewTargetCellId() !== null, {
    timeout: 5000,
  })
  await page.waitForTimeout(700)
  await page.locator('[data-action="record-stop"]').click()
  await page.waitForFunction(
    () => Object.keys(window.__appContext?.clips.clips ?? {}).length === 1,
    { timeout: 30_000 },
  )

  const cellId = await page.evaluate(() => {
    return Object.keys(window.__appContext?.clips.clips ?? {})[0]
  })
  expect(cellId).toBeTruthy()

  // Locate the project dir + verify both mip files exist with non-zero
  // size. Note: under a static / looped fixture the canonical may not
  // compress larger than the mip (encoder bitrate caps + low-motion
  // content), so we don't assert relative size — just that both files
  // are present and non-empty (proves dual encode + dual save fired).
  const fileSizes = await page.evaluate(async (cell) => {
    const projectId = window.__appContext?.projects.activeId()
    if (!projectId) {
      return null
    }
    const root = await navigator.storage.getDirectory()
    const projects = await root.getDirectoryHandle("projects")
    const project = await projects.getDirectoryHandle(projectId)
    const clips = await project.getDirectoryHandle("clips")
    async function size(name: string): Promise<number> {
      try {
        const handle = await clips.getFileHandle(name)
        const file = await handle.getFile()
        return file.size
      } catch {
        return -1
      }
    }
    return {
      hi: await size(`${cell}.720p.webm`),
      lo: await size(`${cell}.270p.webm`),
    }
  }, cellId)

  expect(fileSizes).not.toBeNull()
  expect(fileSizes!.hi).toBeGreaterThan(0)
  expect(fileSizes!.lo).toBeGreaterThan(0)
})
