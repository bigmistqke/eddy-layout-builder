import { expect, test } from "./helpers"
import { activateTool, clickFrame, frameRect, readViewport, waitForSettled } from "./helpers"

test("dev server boots; edit toggle reveals the sub-mode cycle button", async ({ page }) => {
  await page.goto("/")
  const toggle = page.locator('[data-action="toggle-edit"]')
  await expect(toggle).toBeVisible()
  await expect(page.locator('[data-action="cycle-sub-mode"]')).toHaveCount(0)
  await toggle.click()
  const cycle = page.locator('[data-action="cycle-sub-mode"]')
  await expect(cycle).toHaveAttribute("data-tool", "append")
  await cycle.click()
  await expect(cycle).toHaveAttribute("data-tool", "split")
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
  await waitForSettled(page)
  const rect = await frameRect(page, [])
  expect(rect).not.toBeNull()
  expect(rect!.x).toBeGreaterThanOrEqual(-1)
})
