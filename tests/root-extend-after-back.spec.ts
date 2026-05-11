import { expect, test } from "./helpers"
import { activateTool, clickBreadcrumb, clickFrame, clickHandle } from "./helpers"

/**
 * After clicking through some splits and then navigating back to the root
 * via the breadcrumb (segmentIndex 0 = root), the root container is the
 * selected scope. The root's bottom handle sits at canvas bottom-center,
 * which overlaps the bottombar — its `--extend` CSS variable must be set
 * so the notch grows up out of the bottombar's territory.
 */
test("root's bottom handle is extended after breadcrumb-back to root", async ({ page }) => {
  await page.goto("/")
  await activateTool(page, "append")
  await page.waitForTimeout(100)

  // Build a few splits so there's a breadcrumb to navigate.
  await clickFrame(page, [])
  await page.waitForTimeout(200)
  await clickHandle(page, [], "top")
  await page.waitForTimeout(300)
  await clickHandle(page, [0], "left")
  await page.waitForTimeout(300)
  await clickHandle(page, [0, 0], "top")
  await page.waitForTimeout(300)

  // Navigate to root via breadcrumb (leftmost segment = root, depth = path.length).
  await clickBreadcrumb(page, 0)
  await page.waitForTimeout(300)

  // Root frame's bottom handle. Only one selection at a time, so direction
  // alone identifies the handle.
  const bottomNotch = page.locator(`[data-direction="bottom"]`).last()
  const extend = await bottomNotch.evaluate(el => {
    const inline = (el as HTMLElement).style.getPropertyValue("--extend")
    return inline.trim()
  })
  expect(extend).not.toBe("")
  const px = parseFloat(extend)
  expect(px).toBeGreaterThan(0)
})
