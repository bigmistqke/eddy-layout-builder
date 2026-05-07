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
    // Force-dispatch — at deep zoom the breadcrumb's minimap canvas
    // can sit above the handle and intercept native clicks.
    await clickHandle(page, path, dir, { force: true })
    await page.waitForTimeout(280)
  }

  // Read the selected frame's screen-space rect via the test hook.
  const result = await page.evaluate(() => {
    const fn = (window as unknown as { __layoutFrames?: () => unknown }).__layoutFrames
    if (!fn) {
      return null
    }
    const data = fn() as {
      selectedRect: { x: number; y: number; width: number; height: number } | null
      viewport: { x: number; y: number; scale: number }
      canvas: { width: number; height: number }
    }
    if (!data.selectedRect) {
      return null
    }
    const path = document
      .querySelector<HTMLElement>("[data-selected-path]")
      ?.getAttribute("data-selected-path")
    return {
      frame: {
        x: data.selectedRect.x * data.viewport.scale + data.viewport.x,
        y: data.selectedRect.y * data.viewport.scale + data.viewport.y,
        w: data.selectedRect.width * data.viewport.scale,
        h: data.selectedRect.height * data.viewport.scale,
      },
      canvas: { w: data.canvas.width, h: data.canvas.height },
      path,
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
