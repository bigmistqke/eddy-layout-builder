import { test } from "./helpers"
import { type Action, expectFrameRespectsMargin, runActions } from "./helpers"

/**
 * User repro: 14 cascading top-splits, then tap the deepest leaf.
 * After re-selecting the deepest leaf, the selected frame must respect
 * FRAME_PADDING — which implies handles stay inside the viewport.
 */
test("14-deep top-split chain + tap deepest: frame respects margin", async ({ page }) => {
  await page.goto("/")
  const path: number[] = []
  const actions: Action[] = [
    { type: "set-tool", tool: "split" },
    { type: "tap-frame", path: [] },
  ]
  for (let i = 0; i < 14; i++) {
    actions.push({ type: "add-frame", path: [...path], direction: "top", op: "split" })
    path.push(0)
  }
  actions.push({ type: "tap-frame", path: [...path] })
  await runActions(page, actions)
  await expectFrameRespectsMargin(page)
})
