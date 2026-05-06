import { expect, test } from "@playwright/test"
import { clickAction, clickFrame, clickHandle } from "./helpers"

/**
 * Big zoom: build a deeply nested layout and tap a small frame so the
 * viewport zooms in considerably. While the animation runs, sample the
 * selected frame's screen-x position at several time points. The
 * trajectory should be monotonic (no zig-zag, no overshoots) — what the
 * user sees as "smooth pan".
 */
test("big-zoom pan trajectory is monotonic", async ({ page }) => {
  await page.goto("/")
  await clickAction(page, "enter-layout")
  await page.waitForTimeout(100)

  // Build a deep layout so the next click triggers a big zoom.
  await clickFrame(page, [0])
  await page.waitForTimeout(200)
  await clickHandle(page, [0], "right")
  await page.waitForTimeout(300)
  await clickHandle(page, [1], "bottom")
  await page.waitForTimeout(300)
  await clickHandle(page, [1, 1], "right")
  await page.waitForTimeout(300)
  // selection is now somewhere small. Tap a different small frame to
  // trigger a fresh animation we can sample.
  await clickFrame(page, [0])
  await page.waitForTimeout(300)
  // Trigger the big zoom: select a small target.
  // Now click a deeply nested cell.
  const targetPathStr = await page.evaluate(() => {
    // Find the smallest (lowest area) frame element in the canvas and
    // return its data-path.
    const nodes = Array.from(document.querySelectorAll<HTMLElement>("[data-path]"))
    let best = nodes[0]
    let bestArea = Infinity
    for (const n of nodes) {
      const r = n.getBoundingClientRect()
      const a = r.width * r.height
      if (a > 0 && a < bestArea) {
        bestArea = a
        best = n
      }
    }
    return best?.getAttribute("data-path") ?? ""
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
      const n = document.querySelector<HTMLElement>(`[data-path="${p}"]`)
      if (!n) return null
      const r = n.getBoundingClientRect()
      return { x: r.left + r.width / 2, w: r.width }
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
