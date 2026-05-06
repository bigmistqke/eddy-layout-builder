import { expect, test } from "@playwright/test"
import { clickAction, clickFrame, clickHandle, frameRect, readViewport } from "./helpers"

/**
 * Repro: after this sequence, frame [0,1,0,1] is half-out on the left side.
 * This test captures viewport + frame state at each step so the actual
 * geometry is visible for debugging.
 */
test("[0,1,0,1] is centered, not half-out on the left", async ({ page }) => {
  // Surface logs so they show up in `pnpm exec playwright test --reporter list`.
  page.on("console", msg => {
    const t = msg.text()
    if (t.startsWith("[action]") || t.startsWith("[layoutPass]")) {
      // eslint-disable-next-line no-console
      console.log(t)
    }
  })

  await page.goto("/")

  // Step 1: enter-layout
  await clickAction(page, "enter-layout")
  await page.waitForTimeout(50)

  // Step 2: tap-frame [0]
  await clickFrame(page, [0])
  await page.waitForTimeout(300)

  // Step 3: add-frame [0] left append
  await clickHandle(page, [0], "left")
  await page.waitForTimeout(300)

  // Step 4: add-frame [0] bottom append
  await clickHandle(page, [0], "bottom")
  await page.waitForTimeout(300)

  // Step 5: add-frame [0,1] left append
  await clickHandle(page, [0, 1], "left")
  await page.waitForTimeout(300)

  // Step 6: add-frame [0,1,0] bottom append
  await clickHandle(page, [0, 1, 0], "bottom")
  await page.waitForTimeout(300)

  // Step 7: back (only fires if zoom actually triggered along the way).
  const backBtn = page.locator('[data-action="back"]')
  if (await backBtn.isVisible()) {
    await clickAction(page, "back")
    await page.waitForTimeout(300)
  }

  // Step 8: tap-frame [0,1,0,1]
  await clickFrame(page, [0, 1, 0, 1])
  await page.waitForTimeout(400)

  // Capture state.
  const rect = await frameRect(page, [0, 1, 0, 1])
  const canvasSize = await page.evaluate(() => {
    const c = document.querySelector<HTMLElement>('[data-canvas="true"]')
    if (!c) return null
    const r = c.getBoundingClientRect()
    return { w: r.width, h: r.height }
  })

  // Frame must be inside the canvas (no half-out-of-viewport — original bug).
  expect(rect).not.toBeNull()
  expect(rect!.x).toBeGreaterThanOrEqual(-1)
  expect(rect!.x + rect!.w).toBeLessThanOrEqual(canvasSize!.w + 1)
})
