import { test, expect, activateTool, clickFrame } from "./helpers"

test("a HUD growing taller re-runs handle/viewport math", async ({ page }) => {
  await page.goto("/")
  // Enter a tool so handles render and viewport math is active.
  await activateTool(page, "split")
  await clickFrame(page, [])
  await page.waitForTimeout(300)

  // Read the bottom handle's --extend value before the HUD grows.
  // The extend value encodes the handle/viewport math output for this
  // direction; a change proves the pipeline re-ran.
  const beforeExtend = await page.evaluate(() => {
    const bottomHandle = document.querySelector("[data-direction='bottom']") as HTMLElement | null
    if (!bottomHandle) throw new Error("bottom handle not found")
    return bottomHandle.style.getPropertyValue("--extend").trim()
  })

  // Grow the bottom (main) HUD by injecting height onto its element.
  // The HUD changing size must, on its own, drive a handle/viewport recompute.
  await page.evaluate(() => {
    const hud = document
      .querySelector("[data-action='toggle-edit']")
      ?.closest("[class*='_hud_']") as HTMLElement | null
    if (!hud) throw new Error("main HUD not found")
    hud.style.minHeight = "240px"
  })
  await page.waitForTimeout(400)

  // Read the bottom handle's --extend value after the HUD grows.
  const afterExtend = await page.evaluate(() => {
    const bottomHandle = document.querySelector("[data-direction='bottom']") as HTMLElement | null
    if (!bottomHandle) throw new Error("bottom handle not found")
    return bottomHandle.style.getPropertyValue("--extend").trim()
  })

  // The bottom handle must have a larger extend now — the taller HUD
  // pushed the handle further up to clear it. A change here proves the
  // ResizeObserver-driven recompute actually ran and updated handle state.
  expect(afterExtend).not.toBe("")
  expect(afterExtend).not.toBe(beforeExtend)
})
