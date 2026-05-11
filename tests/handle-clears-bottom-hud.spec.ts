import { test } from "./helpers"
import {
  type Action,
  expectFrameRespectsMargin,
  expectHandlesDontOverlap,
  runActions,
} from "./helpers"

/**
 * Repro: split-right four times. The selected frame is so narrow at scale=1
 * that fit-to-target must zoom enough to make WIDTH fill the target box;
 * height then overflows the canvas. Stick clamps top/bottom handles to the
 * canvas edges, and extend pushes them past the HUDs there.
 */
test("deep right-split chain: handles don't overlap each other or HUDs", async ({ page }) => {
  await page.goto("/")
  const actions: Action[] = [
    { type: "set-tool", tool: "split" },
    { type: "tap-frame", path: [] },
    { type: "add-frame", path: [], direction: "right", op: "split" },
    { type: "add-frame", path: [1], direction: "right", op: "split" },
    { type: "add-frame", path: [1, 1], direction: "right", op: "split" },
    { type: "add-frame", path: [1, 1, 1], direction: "right", op: "split" },
  ]
  await runActions(page, actions)
  await expectHandlesDontOverlap(page)
  await expectFrameRespectsMargin(page)
})

/**
 * 15 cascading top splits at the default viewport. Frame respects
 * FRAME_PADDING — which guarantees all four handles sit inside the
 * canvas viewport.
 */
test("15-deep top-split chain: frame respects margin", async ({ page }) => {
  await page.goto("/")
  const path: number[] = []
  const actions: Action[] = [
    { type: "set-tool", tool: "split" },
    { type: "tap-frame", path: [] },
  ]
  for (let i = 0; i < 15; i++) {
    actions.push({ type: "add-frame", path: [...path], direction: "top", op: "split" })
    path.push(0)
  }
  await runActions(page, actions)
  await expectFrameRespectsMargin(page)
})

test("zigzag right/top splits + deep rights: no overlapping handles", async ({ page }) => {
  await page.goto("/")
  const actions: Action[] = [
    { type: "set-tool", tool: "split" },
    { type: "tap-frame", path: [] },
    { type: "add-frame", path: [], direction: "right", op: "split" },
    { type: "add-frame", path: [1], direction: "top", op: "split" },
    { type: "add-frame", path: [1, 0], direction: "right", op: "split" },
    { type: "add-frame", path: [1, 0, 1], direction: "top", op: "split" },
    { type: "add-frame", path: [1, 0, 1, 0], direction: "right", op: "split" },
    { type: "add-frame", path: [1, 0, 1, 0, 1], direction: "right", op: "split" },
    { type: "add-frame", path: [1, 0, 1, 0, 1, 1], direction: "right", op: "split" },
    { type: "add-frame", path: [1, 0, 1, 0, 1, 1, 1], direction: "right", op: "split" },
  ]
  await runActions(page, actions)
  await expectHandlesDontOverlap(page)
  await expectFrameRespectsMargin(page)
})
