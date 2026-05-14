import { test, expect } from "./helpers"
import { activateTool, clickFrame, readViewport } from "./helpers"

test("a HUD growing taller re-runs handle/viewport math", async ({ page }) => {
  await page.goto("/")
  // Enter a tool so handles render and viewport math is active.
  await activateTool(page, "split")
  await clickFrame(page, [])
  await page.waitForTimeout(300)

  const before = await readViewport(page)
  expect(before).not.toBeNull()

  // Grow the bottom (main) HUD by injecting height onto its element.
  // The HUD changing size must, on its own, drive a viewport recompute.
  await page.evaluate(() => {
    const hud = document
      .querySelector("[data-action='toggle-edit']")
      ?.closest("[class*='_hud_']") as HTMLElement | null
    if (!hud) throw new Error("main HUD not found")
    hud.style.minHeight = "240px"
  })
  await page.waitForTimeout(400)

  const after = await readViewport(page)
  expect(after).not.toBeNull()
  // The selected frame's handles now collide with a much taller HUD;
  // the viewport must respond (scale or pan changed).
  const changed =
    Math.abs(after!.x - before!.x) > 1 ||
    Math.abs(after!.y - before!.y) > 1 ||
    Math.abs(after!.scale - before!.scale) > 0.001
  expect(changed).toBe(true)
})
