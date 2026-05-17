import { expect, mockGetUserMedia, test } from "./helpers"

test("bitmap-source: rgba cache file created on record, removed on clip dispose", async ({ page }) => {
  await mockGetUserMedia(page)
  await page.goto("/")

  // Record a clip so blobToClip → makeBitmapSource → writeRgbaCache fires.
  await page.locator('[data-action="record-start"]').click()
  await page.waitForFunction(() => window.__appContext?.previewTargetCellId() !== null, {
    timeout: 5000,
  })
  await page.waitForTimeout(700)
  await page.locator('[data-action="record-stop"]').click()
  await page.waitForFunction(
    () => Object.keys(window.__appContext?.clips.clips ?? {}).length === 1,
    { timeout: 20_000 },
  )

  // Cache file is keyed by clipId (per-recording uuid), not cellId.
  const cacheKey = await page.evaluate(() => {
    const ids = Object.keys(window.__appContext?.clips.clips ?? {})
    const clip = window.__appContext?.clips.clips[ids[0]]
    return clip?.clipId ?? null
  })
  expect(cacheKey).toBeTruthy()

  // The rgba cache file should now exist in OPFS keyed by clipId.
  const exists = await page.evaluate(async (id) => {
    try {
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle("rgba", { create: false })
      await dir.getFileHandle(`${id}.bin`, { create: false })
      return true
    } catch {
      return false
    }
  }, cacheKey)
  expect(exists).toBe(true)

  // Dispose the clip; the cache file should be removed (best-effort).
  // clearClip is keyed by cellId, not clipId.
  await page.evaluate(() => {
    const ids = Object.keys(window.__appContext?.clips.clips ?? {})
    window.__appContext?.clips.clearClip(ids[0])
  })

  // The delete in BitmapSource.close is fire-and-forget; give it a
  // tick to settle.
  await page.waitForTimeout(200)

  const stillExists = await page.evaluate(async (id) => {
    try {
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle("rgba", { create: false })
      await dir.getFileHandle(`${id}.bin`, { create: false })
      return true
    } catch {
      return false
    }
  }, cacheKey)
  expect(stillExists).toBe(false)
})
