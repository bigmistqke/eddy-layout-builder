import { expect, test } from "@playwright/test"
import { activateTool, clickFrame, clickHandle, frameRect } from "./helpers"

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

  await activateTool(page, "append")
  await page.waitForTimeout(50)

  // Initial layout is a single Entity at root.
  await clickFrame(page, [])
  await page.waitForTimeout(300)

  // Build the layout via append handles. First split happens at root.
  await clickHandle(page, [], "left")
  await page.waitForTimeout(300)

  await clickHandle(page, [0], "bottom")
  await page.waitForTimeout(300)

  await clickHandle(page, [0, 1], "left")
  await page.waitForTimeout(300)

  await clickHandle(page, [0, 1, 0], "bottom")
  await page.waitForTimeout(300)

  // Tap the target frame to select and animate to it.
  await clickFrame(page, [0, 1, 0, 1])
  await page.waitForTimeout(400)

  const rect = await frameRect(page, [0, 1, 0, 1])
  const canvasSize = await page.evaluate(() => {
    const c = document.querySelector<HTMLElement>('[data-canvas="true"]')
    if (!c) return null
    const r = c.getBoundingClientRect()
    return { w: r.width, h: r.height }
  })

  expect(rect).not.toBeNull()
  expect(rect!.x).toBeGreaterThanOrEqual(-1)
  expect(rect!.x + rect!.w).toBeLessThanOrEqual(canvasSize!.w + 1)
})
