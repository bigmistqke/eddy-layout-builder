import { expect, test } from "./helpers"
import { clickFrame, waitForSettled } from "./helpers"

test("tap-toggle: cell click toggles selection in song mode", async ({ page }) => {
  await page.goto("/")

  // App opens with root selected + preview active (drives the camera).
  const initial = await page.evaluate(() => window.__appContext?.app.selection ?? null)
  expect(initial).not.toBeNull()
  expect(initial!.preview).toBe(true)

  // Tap the same cell while preview is on → deselect.
  await clickFrame(page, [])
  await waitForSettled(page)
  const afterFirstTap = await page.evaluate(() => window.__appContext?.app.selection ?? null)
  expect(afterFirstTap).toBeNull()

  // Tap again → re-select with preview active.
  await clickFrame(page, [])
  await waitForSettled(page)
  const afterSecondTap = await page.evaluate(() => window.__appContext?.app.selection ?? null)
  expect(afterSecondTap).not.toBeNull()
  expect(afterSecondTap!.preview).toBe(true)
})
