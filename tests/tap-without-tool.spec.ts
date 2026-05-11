import { expect, test } from "./helpers"
import { clickFrame } from "./helpers"

test("tapping a frame with no tool active still selects it", async ({ page }) => {
  await page.goto("/")
  // No setTool — tool is null. Initial layout is a single Entity at root.
  await clickFrame(page, [])
  await page.waitForTimeout(150)
  const selection = await page.evaluate(() => window.__appContext?.app.selection ?? null)
  expect(selection).not.toBeNull()
  expect(selection!.path).toEqual([])
})
