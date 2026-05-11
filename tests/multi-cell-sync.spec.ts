import { expect, test } from "./helpers"
import { mockGetUserMedia } from "./helpers"

test("M2: two cells, record into each, both play", async ({ page }) => {
  await mockGetUserMedia(page)
  await page.goto("/")

  // Split the root into two cells.
  await page.evaluate(() => {
    const context = window.__appContext
    if (context === undefined) {
      throw new Error("no app context")
    }
    context.setSelection({ path: [], depth: 0, preview: true })
    context.handleAddFrame([], "right", "split")
  })

  // Select cell 0, record.
  await page.evaluate(() => {
    window.__appContext?.setSelection({ path: [0], depth: 0, preview: true })
  })
  await page.locator('[data-action="record-start"]').click()
  await page.waitForFunction(() => window.__appContext?.previewTargetCellId() !== null, {
    timeout: 5000,
  })
  await page.waitForTimeout(500)
  await page.locator('[data-action="record-stop"]').click()
  await page.waitForFunction(
    () => Object.keys(window.__appContext?.clips.clips ?? {}).length === 1,
    { timeout: 10_000 },
  )

  // Select cell 1, record. The first clip set songLength, so the second
  // recording auto-stops at that length — no manual record-stop click
  // (the button would detach mid-click as the Show flips).
  await page.evaluate(() => {
    window.__appContext?.setSelection({ path: [1], depth: 0, preview: true })
  })
  await page.locator('[data-action="record-start"]').click()
  await page.waitForFunction(
    () => Object.keys(window.__appContext?.clips.clips ?? {}).length === 2,
    { timeout: 15_000 },
  )

  // Play.
  await page.locator('[data-action="play"]').click()
  await page.waitForFunction(() => window.__appContext?.transport.state() === "playing", {
    timeout: 5000,
  })

  // Both clips' cells should resolve to different ids and be in the
  // clip store.
  const result = await page.evaluate(() => {
    const layout = window.__appContext!.app.layout
    if (layout.type !== "container") {
      throw new Error("expected layout to be a container after split")
    }
    const ids = layout.children.filter(c => c.type === "entity").map(c => c.id)
    const clipIds = Object.keys(window.__appContext!.clips.clips).sort()
    return { layoutIds: ids.sort(), clipIds }
  })
  expect(result.clipIds).toEqual(result.layoutIds)
})
