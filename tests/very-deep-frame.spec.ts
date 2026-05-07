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
    await clickHandle(page, path, dir)
    await page.waitForTimeout(280)
  }

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
