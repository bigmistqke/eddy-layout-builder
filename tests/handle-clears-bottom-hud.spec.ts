import { test } from "@playwright/test"
import {
  type Action,
  expectHandlesDontOverlap,
  expectHandlesInViewport,
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
})

/**
 * Five alternating right/top splits followed by three deepening right
 * splits — selected frame ends up extremely narrow.
 */
/**
 * 15 cascading top splits — same shape as the deep-top margin test
 * but here we verify all four handles are still rendered with positive
 * hit area. User repro: at this depth some handles weren't visible.
 */
test("15-deep top-split chain: all four handles still visible", async ({ page }) => {
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
  await expectHandlesInViewport(page)
  await expectHandlesDontOverlap(page)
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
})
