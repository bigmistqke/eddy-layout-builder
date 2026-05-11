import { test } from "./helpers"
import { type Action, expectFrameRespectsMargin, runActions } from "./helpers"

/**
 * Build a wide-but-short frame via three cascading bottom splits after
 * one right split. Frame is small enough to violate handle-fit minimums
 * (so Rule 1 doesn't short-circuit) and has moderate aspect ratio (so
 * Rule 2's fit-inside applies, not Rule 3's clamp-overflow).
 */
test("Rule 2: small frame zooms aspect-preserved (fit-inside target)", async ({ page }) => {
  await page.goto("/")
  const actions: Action[] = [
    { type: "set-tool", tool: "split" },
    { type: "tap-frame", path: [] },
    { type: "add-frame", path: [], direction: "right", op: "split" },
    { type: "add-frame", path: [1], direction: "bottom", op: "split" },
    { type: "add-frame", path: [1, 1], direction: "bottom", op: "split" },
    { type: "add-frame", path: [1, 1, 1], direction: "bottom", op: "split" },
  ]
  await runActions(page, actions)
  await expectFrameRespectsMargin(page, "fit-inside")
})
