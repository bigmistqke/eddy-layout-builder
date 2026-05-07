import { expect, test } from "@playwright/test"
import { activateTool, clickFrame, clickHandle } from "./helpers"

/**
 * After this sequence of right/top splits, the final selected frame
 * should be centered in the canvas. Original action log:
 *
 *   enter-layout
 *   add-frame [0] right append
 *   add-frame [1] top append
 *   add-frame [1,0] right append
 *   add-frame [1,0,1] top append
 *   add-frame [1,0,1,0] right append
 *   add-frame [1,0,1,0,1] right append
 *   add-frame [1,0,1,0,2] top append
 *   add-frame [1,0,1,0,2,0] right append
 *   add-frame [1,0,1,0,2,0,1] top append
 *   add-frame [1,0,1,0,2,0,1,0] right append
 *   add-frame [1,0,1,0,2,0,1,0,1] top append
 *   add-frame [1,0,1,0,2,0,1,0,1,0] right append
 */
test("deep selected frame is centered after right/top action chain", async ({ page }) => {
  page.on("console", msg => {
    const t = msg.text()
    if (t.startsWith("[layoutPass]") || t.startsWith("[action]")) {
      // eslint-disable-next-line no-console
      console.log(t)
    }
  })
  await page.goto("/")
  await activateTool(page, "append")
  await page.waitForTimeout(100)

  // Initial layout is a single Entity at root (path = []).
  await clickFrame(page, [])
  await page.waitForTimeout(200)

  const sequence: Array<[number[], "top" | "right"]> = [
    [[], "right"],
    [[1], "top"],
    [[1, 0], "right"],
    [[1, 0, 1], "top"],
    [[1, 0, 1, 0], "right"],
    [[1, 0, 1, 0, 1], "right"],
    [[1, 0, 1, 0, 2], "top"],
    [[1, 0, 1, 0, 2, 0], "right"],
    [[1, 0, 1, 0, 2, 0, 1], "top"],
    [[1, 0, 1, 0, 2, 0, 1, 0], "right"],
    [[1, 0, 1, 0, 2, 0, 1, 0, 1], "top"],
    [[1, 0, 1, 0, 2, 0, 1, 0, 1, 0], "right"],
  ]
  for (const [path, dir] of sequence) {
    await clickHandle(page, path, dir)
    await page.waitForTimeout(280)
  }

  // The selected frame is the only one rendering handles — find it via the
  // [data-direction] children, then read its rect relative to canvas.
  const result = await page.evaluate(() => {
    const handle = document.querySelector<HTMLElement>("[data-direction]")
    const selected = handle?.closest<HTMLElement>("[data-path]")
    const canvas = document.querySelector<HTMLElement>('[data-canvas="true"]')
    if (!selected || !canvas) return null
    const s = selected.getBoundingClientRect()
    const c = canvas.getBoundingClientRect()
    return {
      frame: { x: s.left - c.left, y: s.top - c.top, w: s.width, h: s.height },
      canvas: { w: c.width, h: c.height },
      path: selected.getAttribute("data-path"),
    }
  })

  expect(result).not.toBeNull()
  // eslint-disable-next-line no-console
  console.log("selected:", result)

  // The selected frame's center must coincide with the canvas center
  // (within a small tolerance for sub-pixel rounding at high zoom).
  const TOLERANCE = 5
  const frameCx = result!.frame.x + result!.frame.w / 2
  const frameCy = result!.frame.y + result!.frame.h / 2
  expect(Math.abs(frameCx - result!.canvas.w / 2)).toBeLessThan(TOLERANCE)
  expect(Math.abs(frameCy - result!.canvas.h / 2)).toBeLessThan(TOLERANCE)
})
