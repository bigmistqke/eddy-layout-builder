import { test } from "./helpers"
import { type Action, expectFrameRespectsMargin, runActions } from "./helpers"

/**
 * 15-deep alternating right/top split sequence. At this depth the
 * analytical baseRect.w goes negative (each level subtracts a 4px gap
 * from a near-zero parent), so the simple SAME_AXIS_MIN / baseRect.w
 * handle-fit formula breaks. The iterative scale finder must zoom in
 * far enough that the frame still respects FRAME_PADDING — which
 * subsumes "room for handles" and "centered in canvas".
 */
test("15-deep frame respects margin", async ({ page }) => {
  await page.goto("/")
  const actions: Action[] = [
    { type: "set-tool", tool: "append" },
    { type: "tap-frame", path: [] },
    { type: "add-frame", path: [], direction: "right", op: "append" },
    { type: "add-frame", path: [1], direction: "top", op: "append" },
    { type: "add-frame", path: [1, 0], direction: "right", op: "append" },
    { type: "add-frame", path: [1, 0, 1], direction: "top", op: "append" },
    { type: "add-frame", path: [1, 0, 1, 0], direction: "right", op: "append" },
    { type: "add-frame", path: [1, 0, 1, 0, 1], direction: "top", op: "append" },
    { type: "add-frame", path: [1, 0, 1, 0, 1, 0], direction: "right", op: "append" },
    { type: "add-frame", path: [1, 0, 1, 0, 1, 0, 1], direction: "top", op: "append" },
    { type: "add-frame", path: [1, 0, 1, 0, 1, 0, 1, 0], direction: "right", op: "append" },
    { type: "add-frame", path: [1, 0, 1, 0, 1, 0, 1, 0, 1], direction: "top", op: "append" },
    { type: "add-frame", path: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0], direction: "right", op: "append" },
    { type: "add-frame", path: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1], direction: "top", op: "append" },
    {
      type: "add-frame",
      path: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
      direction: "right",
      op: "append",
    },
    {
      type: "add-frame",
      path: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1],
      direction: "top",
      op: "append",
    },
    {
      type: "add-frame",
      path: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
      direction: "right",
      op: "append",
    },
  ]
  await runActions(page, actions)
  await expectFrameRespectsMargin(page)
})
