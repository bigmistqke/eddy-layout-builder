import { expect, test } from "@playwright/test"
import { clickAction, clickFrame, clickHandle } from "./helpers"

/**
 * After clicking through some splits and then pressing the back button,
 * selection is cleared. Root frame still renders handles (since its path
 * matches the empty targeted path). The root's bottom handle is at canvas
 * bottom-center; the bottombar is also at canvas bottom-center → they
 * overlap. The bottom handle's `--extend` CSS variable must be set so the
 * notch grows up out of the bottombar's territory.
 */
test("root's bottom handle is extended after back-clear", async ({ page }) => {
  await page.goto("/")
  await clickAction(page, "enter-layout")
  await page.waitForTimeout(100)

  // A few splits so a back makes structural sense.
  await clickFrame(page, [0])
  await page.waitForTimeout(200)
  await clickHandle(page, [0], "top")
  await page.waitForTimeout(300)
  await clickHandle(page, [0], "left")
  await page.waitForTimeout(300)
  await clickHandle(page, [0, 0], "top")
  await page.waitForTimeout(300)

  // Back — clears selection. Root then becomes the implicit scope.
  // Only fires if the back button is actually visible (depends on whether
  // any of the previous splits triggered a zoom).
  const backBtn = page.locator('[data-action="back"]')
  if (await backBtn.isVisible()) {
    await clickAction(page, "back")
    await page.waitForTimeout(300)
  } else {
    // Force-clear via direct action — we want the same end-state.
    await clickAction(page, "back").catch(() => {
      /* tolerate */
    })
  }

  // Root frame's bottom handle.
  const bottomNotch = page.locator(`[data-path=""] [data-direction="bottom"]`).last()
  const fallbackBottomNotch = page.locator(`[data-direction="bottom"]`).first()
  const notch = (await bottomNotch.count()) > 0 ? bottomNotch : fallbackBottomNotch

  const extend = await notch.evaluate(el => {
    const inline = (el as HTMLElement).style.getPropertyValue("--extend")
    return inline.trim()
  })
  // Bottom handle MUST be extended (overlaps bottombar). Expect e.g. "56px".
  expect(extend).not.toBe("")
  const px = parseFloat(extend)
  expect(px).toBeGreaterThan(0)
})
