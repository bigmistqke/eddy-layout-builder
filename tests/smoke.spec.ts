import { expect, test } from "./helpers"
import { activateTool, clickFrame, frameRect, readViewport } from "./helpers"

test("dev server boots and tool buttons render", async ({ page }) => {
  await page.goto("/")
  // The add-mode entry point sits in the main HUD and is always
  // visible; the per-tool buttons (append/split) only mount in the
  // contextual HUD once add-mode is active.
  await expect(page.locator('[data-action="toggle-add"]')).toBeVisible()
  await page.locator('[data-action="toggle-add"]').click()
  await expect(page.locator('[data-action="set-tool-append"]')).toBeVisible()
})

test("activating a tool shows the canvas inner", async ({ page }) => {
  await page.goto("/")
  await activateTool(page, "append")
  const inner = await readViewport(page)
  expect(inner).not.toBeNull()
})

test("clicking the root frame keeps it inside the canvas", async ({ page }) => {
  await page.goto("/")
  await activateTool(page, "append")
  // Initial layout is a single Entity at root (path = []).
  await clickFrame(page, [])
  await page.waitForTimeout(300)
  const rect = await frameRect(page, [])
  expect(rect).not.toBeNull()
  expect(rect!.x).toBeGreaterThanOrEqual(-1)
})
