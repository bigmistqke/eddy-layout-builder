import { expect, test } from "@playwright/test"
import { runActions } from "./helpers"

/**
 * Build a frame that is wide but short — three cascading bottom splits
 * after one right split give us a frame ~half-canvas wide × ~1/8 canvas
 * tall, which is small enough to violate the handle-fit minimums (so
 * Rule 1 doesn't short-circuit) and has a moderate aspect ratio (so
 * Rule 2's fit-inside applies, not Rule 3's clamp-overflow). Assert:
 *   - the frame's binding axis hits the target dimension
 *   - the OTHER axis is strictly less than its target (no stretch)
 */
test("Rule 2: small frame zooms aspect-preserved (fit-inside target)", async ({ page }) => {
  await page.goto("/")

  await runActions(
    page,
    `
    [action] {"type":"set-tool","tool":"split"}
    [action] {"type":"tap-frame","path":[]}
    [action] {"type":"add-frame","path":[],"direction":"right","op":"split"}
    [action] {"type":"add-frame","path":[1],"direction":"bottom","op":"split"}
    [action] {"type":"add-frame","path":[1,1],"direction":"bottom","op":"split"}
    [action] {"type":"add-frame","path":[1,1,1],"direction":"bottom","op":"split"}
    `,
  )

  const result = await page.evaluate(() => {
    const handle = document.querySelector<HTMLElement>("[data-direction='bottom']")
    const selected = handle?.closest<HTMLElement>("[data-path]")
    const canvas = document.querySelector<HTMLElement>("[data-canvas='true']")
    if (!selected || !canvas) {
      return null
    }
    const s = selected.getBoundingClientRect()
    const c = canvas.getBoundingClientRect()
    return {
      frame: { w: s.width, h: s.height },
      canvas: { w: c.width, h: c.height },
    }
  })

  expect(result).not.toBeNull()

  // FRAME_PADDING in src/constants.ts is 2 * HANDLE_H = 96. Hardcode the
  // target dims here rather than importing src code into a Playwright
  // test (Playwright loads tests outside vite — direct import would
  // require extra config).
  const FRAME_PADDING = 96
  const targetWidth = result!.canvas.w - 2 * FRAME_PADDING
  const targetHeight = result!.canvas.h - 2 * FRAME_PADDING

  // Tolerance accounts for sub-pixel drift from the iterative flex-math
  // scale solver — converges within ~1-2 px.
  const TOLERANCE = 3
  // The frame must fit *inside* the target box on both axes.
  expect(result!.frame.w).toBeLessThanOrEqual(targetWidth + TOLERANCE)
  expect(result!.frame.h).toBeLessThanOrEqual(targetHeight + TOLERANCE)
  // At least one axis is at the target (the binding axis).
  const widthAtTarget = Math.abs(result!.frame.w - targetWidth) < TOLERANCE
  const heightAtTarget = Math.abs(result!.frame.h - targetHeight) < TOLERANCE
  expect(widthAtTarget || heightAtTarget, "neither axis hit target").toBe(true)
  // The non-binding axis must be STRICTLY LESS than its target — proves
  // aspect was preserved, not stretched to fill.
  if (widthAtTarget) {
    expect(result!.frame.h).toBeLessThan(targetHeight - TOLERANCE)
  } else {
    expect(result!.frame.w).toBeLessThan(targetWidth - TOLERANCE)
  }
})
