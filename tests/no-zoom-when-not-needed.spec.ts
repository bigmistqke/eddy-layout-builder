import { expect, test } from "./helpers"
import { type Action, runActions } from "./helpers"

/**
 * Single split-right from the root entity. The selected frame [1] is
 * roughly half the canvas — handles fit naturally with no overlap, so the
 * viewport must NOT zoom in. Asserted by reading the canvasInner's
 * inline-style scale (width === viewport width when scale=1).
 */
test("single split-right does not trigger zoom", async ({ page }) => {
  await page.goto("/")

  const actions: Action[] = [
    { type: "set-tool", tool: "split" },
    { type: "tap-frame", path: [] },
    { type: "add-frame", path: [], direction: "right", op: "split" },
  ]
  await runActions(page, actions)

  const viewport = await page.evaluate(() => {
    const fn = (
      window as unknown as {
        __layoutFrames?: () => { viewport: { x: number; y: number; scale: number } }
      }
    ).__layoutFrames
    if (!fn) {
      return null
    }
    return fn().viewport
  })

  expect(viewport).not.toBeNull()
  // Identity viewport: scale 1 with zero translate.
  expect(viewport!.scale).toBe(1)
  expect(Math.abs(viewport!.x)).toBeLessThan(1)
  expect(Math.abs(viewport!.y)).toBeLessThan(1)
})
