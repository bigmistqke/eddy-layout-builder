import { expect, test } from "./helpers"
import { runActions, type Action } from "./helpers"

test("layout edits survive page reload", async ({ page }) => {
  await page.goto("/")

  const actions: Action[] = [
    { type: "set-tool", tool: "split" },
    { type: "add-frame", path: [], direction: "right", op: "split" },
  ]
  await runActions(page, actions)

  const before = await page.evaluate(() =>
    JSON.stringify(window.__appContext?.app.layout ?? null),
  )

  // Wait for the auto-save effect to flush its manifest write.
  await page.waitForTimeout(300)
  await page.reload()
  await page.waitForFunction(
    () => {
      const layout = window.__appContext?.app.layout
      return layout?.type === "container"
    },
    { timeout: 5000 },
  )

  const after = await page.evaluate(() =>
    JSON.stringify(window.__appContext?.app.layout ?? null),
  )
  expect(after).toBe(before)
})

test("deep layout edits survive page reload", async ({ page }) => {
  // Regression: the first split (`nodePath.length === 0`) reassigns
  // `app.layout` so the auto-save effect's top-level read fires;
  // subsequent splits mutate deeper without reassigning the root. The
  // auto-save dep must track the tree recursively, or these deeper
  // edits silently never persist.
  await page.goto("/")
  await runActions(page, [
    { type: "set-tool", tool: "split" },
    { type: "add-frame", path: [], direction: "right", op: "split" },
    { type: "add-frame", path: [1], direction: "bottom", op: "split" },
    { type: "add-frame", path: [1, 1], direction: "right", op: "split" },
  ])

  const before = await page.evaluate(() =>
    JSON.stringify(window.__appContext?.app.layout ?? null),
  )
  await page.waitForTimeout(300)
  await page.reload()
  await page.waitForFunction(
    () => {
      const layout = window.__appContext?.app.layout
      return layout?.type === "container"
    },
    { timeout: 5000 },
  )

  const after = await page.evaluate(() =>
    JSON.stringify(window.__appContext?.app.layout ?? null),
  )
  expect(after).toBe(before)
})

test("new project clears the in-memory layout", async ({ page }) => {
  await page.goto("/")
  await runActions(page, [
    { type: "set-tool", tool: "split" },
    { type: "add-frame", path: [], direction: "right", op: "split" },
  ])

  // Open project menu, hit New Project.
  await page.locator('[data-action="open-project-menu"]').click()
  await page.locator('[data-action="new-project"]').click()
  await page.waitForFunction(() => window.__appContext?.app.layout.type === "entity", {
    timeout: 5000,
  })

  const layout = await page.evaluate(() => window.__appContext?.app.layout)
  expect(layout?.type).toBe("entity")
})
