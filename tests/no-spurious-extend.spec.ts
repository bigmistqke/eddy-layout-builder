import { expect, test } from "./helpers"
import { activateTool, clickFrame } from "./helpers"

/**
 * Activating a tool and selecting the root entity shows handles on the
 * full-canvas frame. The breadcrumb occupies the top-left corner only
 * (small notch), so the top handle (centered horizontally) does NOT
 * overlap with the breadcrumb. The top handle's CSS --extend var should
 * stay unset / 0.
 */
test("top handle is not extended when no actual HUD overlap", async ({ page }) => {
  await page.goto("/")
  await activateTool(page, "append")
  // Initial layout is a single Entity at root (path = []).
  await clickFrame(page, [])
  await page.waitForTimeout(200)

  // Only one selection at a time, so direction alone identifies the handle.
  const topNotch = page.locator(`[data-direction="top"]`).last()
  const extend = await topNotch.evaluate(el => {
    const inline = (el as HTMLElement).style.getPropertyValue("--extend")
    return inline.trim()
  })
  expect(extend).toBe("")
})
