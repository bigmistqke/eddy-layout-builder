import { expect, test } from "./helpers"
import { activateTool, clickFrame, clickHandle } from "./helpers"

/**
 * Big zoom: build a deeply nested layout and tap a small frame so the
 * viewport zooms in considerably. While the animation runs, sample the
 * selected frame's screen-x position at several time points. The
 * trajectory should be monotonic (no zig-zag, no overshoots) — what the
 * user sees as "smooth pan".
 */
test("big-zoom pan trajectory is monotonic", async ({ page }) => {
  await page.goto("/")
  await activateTool(page, "append")
  await page.waitForTimeout(100)

  // Build a deep layout so the next click triggers a big zoom.
  await clickFrame(page, [])
  await page.waitForTimeout(200)
  await clickHandle(page, [], "right")
  await page.waitForTimeout(300)
  await clickHandle(page, [1], "bottom")
  await page.waitForTimeout(300)
  await clickHandle(page, [1, 1], "right")
  await page.waitForTimeout(300)
  // selection is now somewhere small. Tap a different small frame to
  // trigger a fresh animation we can sample. Use `force` because the
  // current zoom may have panned [0] outside the browser viewport.
  await clickFrame(page, [0], { force: true })
  await page.waitForTimeout(300)
  // Trigger the big zoom: select a small target.
  // Now click a deeply nested cell.
  const targetPathStr = await page.evaluate(() => {
    // Find the smallest (lowest area) leaf in the layout via the test hook.
    const fn = (window as unknown as { __layoutFrames?: () => unknown }).__layoutFrames
    if (!fn) {
      return ""
    }
    const data = fn() as {
      leaves: Array<{
        path: number[]
        rect: { x: number; y: number; width: number; height: number }
      }>
      viewport: { x: number; y: number; scale: number }
    }
    let bestPath = ""
    let bestArea = Infinity
    for (const leaf of data.leaves) {
      const w = leaf.rect.width * data.viewport.scale
      const h = leaf.rect.height * data.viewport.scale
      const area = w * h
      if (area > 0 && area < bestArea) {
        bestArea = area
        bestPath = leaf.path.join(".")
      }
    }
    return bestPath
  })
  expect(targetPathStr).not.toBe("")
  const targetPath = targetPathStr.split(".").map(Number)

  // Trigger the zoom and sample x-position over 220ms.
  await clickFrame(page, targetPath)

  // Sample every 20ms for 220ms.
  const samples: { t: number; x: number; w: number }[] = []
  const start = Date.now()
  for (let i = 0; i < 12; i++) {
    const sample = await page.evaluate(p => {
      const fn = (window as unknown as { __layoutFrames?: () => unknown }).__layoutFrames
      if (!fn) {
        return null
      }
      const data = fn() as {
        leaves: Array<{
          path: number[]
          rect: { x: number; y: number; width: number; height: number }
        }>
        viewport: { x: number; y: number; scale: number }
        canvas: { left: number }
      }
      const leaf = data.leaves.find(l => l.path.join(".") === p)
      if (!leaf) {
        return null
      }
      const screenX = leaf.rect.x * data.viewport.scale + data.viewport.x
      const screenW = leaf.rect.width * data.viewport.scale
      return { x: data.canvas.left + screenX + screenW / 2, w: screenW }
    }, targetPathStr)
    if (sample) samples.push({ t: Date.now() - start, ...sample })
    await page.waitForTimeout(20)
  }

  // Trajectory should be monotonic in one direction (toward final pos).
  // Compute deltas and confirm no sign changes (allowing tiny noise).
  const xs = samples.map(s => s.x)
  // Compute the dominant direction.
  const totalDelta = xs[xs.length - 1] - xs[0]
  // Each step's delta should have the same sign as totalDelta (or be ~0).
  let signFlips = 0
  for (let i = 1; i < xs.length; i++) {
    const d = xs[i] - xs[i - 1]
    if (Math.abs(d) < 1) continue // ignore sub-pixel jitter
    if (Math.sign(d) !== Math.sign(totalDelta)) signFlips++
  }
  // At most 1 flip allowed (tiny tail oscillation around the final value).
  expect(signFlips).toBeLessThanOrEqual(1)
})
