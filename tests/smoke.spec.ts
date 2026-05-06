import { expect, test } from "@playwright/test"
import { clickAction, clickFrame, frameRect, readViewport } from "./helpers"

test("dev server boots and recording view renders", async ({ page }) => {
  await page.goto("/")
  await expect(page.locator('[data-action="enter-layout"]')).toBeVisible()
})

test("entering layout mode shows the canvas inner", async ({ page }) => {
  await page.goto("/")
  await clickAction(page, "enter-layout")
  const inner = await readViewport(page)
  expect(inner).not.toBeNull()
})

test("clicking a frame keeps it inside the canvas", async ({ page }) => {
  await page.goto("/")
  await clickAction(page, "enter-layout")
  await clickFrame(page, [0])
  await page.waitForTimeout(300)
  const rect = await frameRect(page, [0])
  expect(rect).not.toBeNull()
  expect(rect!.x).toBeGreaterThanOrEqual(-1)
})
