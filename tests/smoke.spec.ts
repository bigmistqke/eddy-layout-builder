import { expect, test } from "@playwright/test"
import { clickFrame, frameRect, readViewport } from "./helpers"

test("dev server boots and recording view renders", async ({ page }) => {
  await page.goto("/")
  // The recording view's `+` button enters layout mode.
  await expect(page.locator(".barButton").first()).toBeVisible()
})

test("entering layout mode shows the canvas inner", async ({ page }) => {
  await page.goto("/")
  await page.locator(".barButton").first().click()
  const inner = await readViewport(page)
  expect(inner).not.toBeNull()
})

test("clicking a frame keeps it inside the canvas", async ({ page }) => {
  await page.goto("/")
  // Enter layout mode.
  await page.locator(".barButton").first().click()
  // Click the only frame (path=[0]).
  await clickFrame(page, [0])
  // Wait for animation to settle.
  await page.waitForTimeout(300)
  const rect = await frameRect(page, [0])
  expect(rect).not.toBeNull()
  // Frame's left edge must be inside the canvas (no half-out-of-viewport).
  expect(rect!.x).toBeGreaterThanOrEqual(-1)
})
