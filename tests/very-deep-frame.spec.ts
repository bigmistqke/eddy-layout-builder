import { expect, test } from "@playwright/test"
import { activateTool, clickFrame, clickHandle } from "./helpers"

/**
 * 15-deep alternating right/top split sequence. At this depth the
 * analytical baseRect.w goes negative (each level subtracts a 4px gap
 * from a near-zero parent), so the simple SAME_AXIS_MIN / baseRect.w
 * handle-fit formula breaks. The iterative scale finder must zoom in
 * far enough that the frame still has room for handles and lands
 * centered in the canvas.
 */
test("15-deep frame still has room for handles and is centered", async ({ page }) => {
  await page.goto("/")
  await activateTool(page, "append")
  await page.waitForTimeout(100)

  // Initial layout is a single Entity at root.
  await clickFrame(page, [])
  await page.waitForTimeout(200)

  const sequence: Array<[number[], "top" | "right"]> = [
    [[], "right"],
    [[1], "top"],
    [[1, 0], "right"],
    [[1, 0, 1], "top"],
    [[1, 0, 1, 0], "right"],
    [[1, 0, 1, 0, 1], "top"],
    [[1, 0, 1, 0, 1, 0], "right"],
    [[1, 0, 1, 0, 1, 0, 1], "top"],
    [[1, 0, 1, 0, 1, 0, 1, 0], "right"],
    [[1, 0, 1, 0, 1, 0, 1, 0, 1], "top"],
    [[1, 0, 1, 0, 1, 0, 1, 0, 1, 0], "right"],
    [[1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1], "top"],
    [[1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0], "right"],
    [[1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1], "top"],
    [[1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0], "right"],
  ]
  for (const [path, dir] of sequence) {
    await clickHandle(page, path, dir, { force: true })
    await page.waitForTimeout(280)
  }

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

  // Frame must have room for handles (≥ ~140px, the SAME_AXIS_MIN constant).
  expect(result!.frame.w).toBeGreaterThan(100)
  expect(result!.frame.h).toBeGreaterThan(100)

  // Centered in the canvas.
  const TOLERANCE = 5
  const frameCx = result!.frame.x + result!.frame.w / 2
  const frameCy = result!.frame.y + result!.frame.h / 2
  expect(Math.abs(frameCx - result!.canvas.w / 2)).toBeLessThan(TOLERANCE)
  expect(Math.abs(frameCy - result!.canvas.h / 2)).toBeLessThan(TOLERANCE)
})
