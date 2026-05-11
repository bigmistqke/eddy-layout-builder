import { expect, test } from "@playwright/test"
import { mockGetUserMedia } from "./helpers"

test("M3: first recording sets songLength", async ({ page }) => {
  await mockGetUserMedia(page)
  await page.goto("/")
  await page.locator('[data-action="record-start"]').click()
  await page.waitForFunction(() => window.__appContext?.preview.targetCellId() !== null, {
    timeout: 5000,
  })
  await page.waitForTimeout(700)
  await page.locator('[data-action="record-stop"]').click()
  await page.waitForFunction(() => window.__appContext?.songLength() !== null, {
    timeout: 10_000,
  })

  const length = await page.evaluate(() => window.__appContext?.songLength())
  expect(length).toBeGreaterThan(0.5)
  expect(length).toBeLessThan(2)
})

test("M3: deleting the last clip resets songLength", async ({ page }) => {
  await mockGetUserMedia(page)
  await page.goto("/")
  await page.locator('[data-action="record-start"]').click()
  await page.waitForFunction(() => window.__appContext?.preview.targetCellId() !== null, {
    timeout: 5000,
  })
  await page.waitForTimeout(600)
  await page.locator('[data-action="record-stop"]').click()
  await page.waitForFunction(() => window.__appContext?.songLength() !== null, {
    timeout: 10_000,
  })

  // Select the root entity then delete. Separate evaluate calls so the
  // setSelection store write flushes (Solid 2.x batches on microtasks)
  // before deleteSelection reads `app.selection`.
  await page.evaluate(() => {
    window.__appContext!.setSelection({ path: [], depth: 0 })
  })
  await page.evaluate(() => {
    window.__appContext!.deleteSelection()
  })

  const result = await page.evaluate(() => ({
    songLength: window.__appContext?.songLength(),
    clipCount: Object.keys(window.__appContext?.clips.clips ?? {}).length,
  }))
  expect(result.songLength).toBeNull()
  expect(result.clipCount).toBe(0)
})

test("M3: subsequent recording is clamped to songLength", async ({ page }) => {
  await mockGetUserMedia(page)
  await page.goto("/")

  // Anchor with ~0.5s clip.
  await page.locator('[data-action="record-start"]').click()
  await page.waitForFunction(() => window.__appContext?.preview.targetCellId() !== null, {
    timeout: 5000,
  })
  await page.waitForTimeout(500)
  await page.locator('[data-action="record-stop"]').click()
  await page.waitForFunction(() => window.__appContext?.songLength() !== null, {
    timeout: 10_000,
  })
  const anchorLength = await page.evaluate(() => window.__appContext!.songLength()!)
  expect(anchorLength).toBeGreaterThan(0)

  // Split, select cell 1, start recording — auto-stop should fire at songLength.
  await page.evaluate(() => {
    const context = window.__appContext!
    context.setSelection({ path: [], depth: 0 })
    context.handleAddFrame([], "right", "split")
    context.setSelection({ path: [1], depth: 0 })
  })

  await page.locator('[data-action="record-start"]').click()
  // Wait longer than anchorLength + processing margin; the auto-stop
  // should have fired and the clip should have landed.
  await page.waitForFunction(
    () => Object.keys(window.__appContext?.clips.clips ?? {}).length === 2,
    { timeout: 15_000 },
  )

  const result = await page.evaluate(() => ({
    clipCount: Object.keys(window.__appContext!.clips.clips).length,
    previewActive: window.__appContext!.preview.targetCellId() !== null,
  }))
  expect(result.clipCount).toBe(2)
  expect(result.previewActive).toBe(false)
})
