import { expect, test } from "@playwright/test"
import { clickAction } from "./helpers"

/**
 * Entering layout mode shows a single full-canvas entity. The breadcrumb
 * occupies the top-left corner only (small notch). The frame's top handle
 * is centered horizontally; it does NOT overlap with the breadcrumb. So
 * the top handle should NOT be visually extended (its CSS --extend var
 * should be unset / 0).
 */
test("top handle is not extended when no actual HUD overlap", async ({ page }) => {
  await page.goto("/")
  await clickAction(page, "enter-layout")
  await page.waitForTimeout(200)

  // The selected (root) frame's top notch.
  const topNotch = page.locator(`[data-path="0"] [data-direction="top"]`).last()
  // Read its --extend CSS variable from the inline style (or computed).
  const extend = await topNotch.evaluate(el => {
    const inline = (el as HTMLElement).style.getPropertyValue("--extend")
    return inline.trim()
  })
  // Should be empty (no extend applied) since handle doesn't overlap HUD.
  expect(extend).toBe("")
})
