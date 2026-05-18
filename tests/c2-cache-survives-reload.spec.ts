import { expect, mockGetUserMedia, test } from "./helpers"

test("c2 cache reuse: rgba cache survives reload, clipId persists", async ({ page }) => {
  await mockGetUserMedia(page)
  await page.goto("/")

  // Record once; cold path runs.
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

  // Capture the clipId so we can verify the cache file persists and the
  // manifest carries it across the reload.
  const originalClipId = await page.evaluate(() => {
    const ids = Object.keys(window.__appContext?.clips.clips ?? {})
    return window.__appContext?.clips.clips[ids[0]]?.clipId ?? null
  })
  expect(originalClipId).toBeTruthy()

  // Force-flush the manifest with cells[] populated — the auto-save
  // effect would do this on a microtask, but waiting wall-clock for it
  // races with CPU contention. Explicit save mirrors opfs-persistence.
  await page.evaluate(() => window.__appContext?.projects.saveCurrent())
  await page.waitForFunction(
    (clipId) => {
      const manifest = window.__appContext?.projects.active()
      return manifest?.cells?.some((c: { clipId: string }) => c.clipId === clipId) ?? false
    },
    originalClipId,
    { timeout: 5000 },
  )

  // Reload — load path should hit the hot start (rgba cache file exists,
  // manifest carries clipId + cache metadata, blobToClip's canHotStart
  // branch fires).
  await mockGetUserMedia(page)
  await page.reload()
  await page.waitForFunction(
    () => Object.keys(window.__appContext?.clips.clips ?? {}).length === 1,
    { timeout: 30_000 },
  )

  // The new Clip should reuse the SAME clipId (persisted from manifest).
  const reloadedClipId = await page.evaluate(() => {
    const ids = Object.keys(window.__appContext?.clips.clips ?? {})
    return window.__appContext?.clips.clips[ids[0]]?.clipId ?? null
  })
  expect(reloadedClipId).toBe(originalClipId)

  // The rgba file with that clipId should be present (would have been
  // GC'd or not regenerated if the hot-path logic regressed).
  const cacheExists = await page.evaluate(async (id) => {
    try {
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle("rgba", { create: false })
      await dir.getFileHandle(`${id}.bin`, { create: false })
      return true
    } catch {
      return false
    }
  }, reloadedClipId)
  expect(cacheExists).toBe(true)
})
