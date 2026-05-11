import { test } from "./helpers"
import { type Action, expectFrameRespectsMargin, runActions } from "./helpers"

/**
 * After this sequence of right/top append-splits, the final selected
 * frame must respect FRAME_PADDING — which implies it's centered in
 * the canvas with the binding axis hitting target.
 */
test("deep selected frame respects margin after right/top action chain", async ({ page }) => {
  await page.goto("/")
  const actions: Action[] = [
    { type: "set-tool", tool: "append" },
    { type: "tap-frame", path: [] },
    { type: "add-frame", path: [], direction: "right", op: "append" },
    { type: "add-frame", path: [1], direction: "top", op: "append" },
    { type: "add-frame", path: [1, 0], direction: "right", op: "append" },
    { type: "add-frame", path: [1, 0, 1], direction: "top", op: "append" },
    { type: "add-frame", path: [1, 0, 1, 0], direction: "right", op: "append" },
    { type: "add-frame", path: [1, 0, 1, 0, 1], direction: "right", op: "append" },
    { type: "add-frame", path: [1, 0, 1, 0, 2], direction: "top", op: "append" },
    { type: "add-frame", path: [1, 0, 1, 0, 2, 0], direction: "right", op: "append" },
    { type: "add-frame", path: [1, 0, 1, 0, 2, 0, 1], direction: "top", op: "append" },
    { type: "add-frame", path: [1, 0, 1, 0, 2, 0, 1, 0], direction: "right", op: "append" },
    { type: "add-frame", path: [1, 0, 1, 0, 2, 0, 1, 0, 1], direction: "top", op: "append" },
    { type: "add-frame", path: [1, 0, 1, 0, 2, 0, 1, 0, 1, 0], direction: "right", op: "append" },
  ]
  await runActions(page, actions)
  await expectFrameRespectsMargin(page)
})
