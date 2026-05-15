import { activateTool, expect, mockGetUserMedia, test, waitForSettled } from "./helpers"

test("initial selection lands on root with preview active", async ({ page }) => {
  await page.goto("/")
  const state = await page.evaluate(() => {
    const context = window.__appContext
    if (context === undefined) {
      return null
    }
    const selection = context.app.selection
    return {
      selection,
      previewTarget: context.previewTargetCellId(),
    }
  })
  expect(state).not.toBeNull()
  expect(state!.selection).not.toBeNull()
  expect(state!.selection!.preview).toBe(true)
  expect(state!.previewTarget).toBe(
    await page.evaluate(() => {
      const layout = window.__appContext!.app.layout
      return layout.type === "entity" ? layout.id : null
    }),
  )
})

test("split previews camera in the newly-created cell", async ({ page }) => {
  await page.goto("/")
  // Activate split mode and split the root.
  await activateTool(page, "split")
  await page.evaluate(() => {
    const context = window.__appContext!
    context.handleAddFrame([], "right", "split")
  })
  const state = await page.evaluate(() => {
    const context = window.__appContext!
    const selection = context.app.selection
    const target = context.previewTargetCellId()
    const layout = context.app.layout
    const newCellId =
      layout.type === "container" && layout.children[1]?.type === "entity"
        ? layout.children[1].id
        : null
    return { selection, target, newCellId }
  })
  expect(state.selection).not.toBeNull()
  expect(state.selection!.preview).toBe(true)
  expect(state.target).toBe(state.newCellId)
})

test("record button is disabled when no cell is selected", async ({ page }) => {
  await page.goto("/")
  // Deselect: tap the currently-selected root cell.
  await page.evaluate(() => {
    window.__appContext!.setSelection(null)
  })
  await waitForSettled(page)
  const isDisabled = await page
    .locator('[data-action="record-start"]')
    .evaluate(element => (element as HTMLButtonElement).disabled)
  expect(isDisabled).toBe(true)
})

test("record button is enabled when a cell is selected", async ({ page }) => {
  await page.goto("/")
  // Initial state has root selected, but the button is also gated on
  // preview.stream being non-null — i.e. gUM has resolved. Wait for
  // the gate to actually drop before asserting.
  await page.locator('[data-action="record-start"]:not([disabled])').waitFor({ timeout: 5000 })
  const isDisabled = await page
    .locator('[data-action="record-start"]')
    .evaluate(element => (element as HTMLButtonElement).disabled)
  expect(isDisabled).toBe(false)
})

test("record exits tool mode but keeps the selection", async ({ page }) => {
  await mockGetUserMedia(page)
  await page.goto("/")
  await activateTool(page, "split")
  // Record from tool mode.
  await page.locator('[data-action="record-start"]').click()
  // onRecord clears the tool synchronously then awaits the stream — wait
  // for the tool clear to land instead of a wall-clock buffer.
  await page.waitForFunction(() => window.__appContext?.app.tool === null, { timeout: 5000 })
  const state = await page.evaluate(() => {
    const context = window.__appContext!
    return {
      tool: context.app.tool,
      selection: context.app.selection,
    }
  })
  expect(state.tool).toBeNull()
  expect(state.selection).not.toBeNull()
})

test("post-record state: cell shows its clip's frame (preview goes off)", async ({ page }) => {
  await mockGetUserMedia(page)
  await page.goto("/")
  await page.locator('[data-action="record-start"]').click()
  await page.waitForTimeout(400)
  await page.locator('[data-action="record-stop"]').click()
  await page.waitForFunction(
    () =>
      window.__appContext !== undefined &&
      Object.keys(window.__appContext.clips.clips).length === 1 &&
      window.__appContext.previewTargetCellId() === null,
    { timeout: 20_000 },
  )
  const state = await page.evaluate(() => {
    const context = window.__appContext!
    return {
      selection: context.app.selection,
      previewTarget: context.previewTargetCellId(),
    }
  })
  // Selection persists; preview switches off; previewTargetCellId clears.
  expect(state.selection).not.toBeNull()
  expect(state.selection!.preview).toBe(false)
  expect(state.previewTarget).toBeNull()
})

test("autoplay: transport starts playing after record-stop", async ({ page }) => {
  await mockGetUserMedia(page)
  await page.goto("/")
  await page.locator('[data-action="record-start"]').click()
  await page.waitForTimeout(400)
  await page.locator('[data-action="record-stop"]').click()
  // Once the clip lands and song-length is set, autoplay kicks in.
  await page.waitForFunction(
    () =>
      window.__appContext !== undefined &&
      window.__appContext.transport.state() === "playing",
    { timeout: 20_000 },
  )
})

test("tapping the post-record cell re-activates preview", async ({ page }) => {
  await mockGetUserMedia(page)
  await page.goto("/")
  await page.locator('[data-action="record-start"]').click()
  await page.waitForTimeout(400)
  await page.locator('[data-action="record-stop"]').click()
  await page.waitForFunction(
    () =>
      window.__appContext !== undefined &&
      Object.keys(window.__appContext.clips.clips).length === 1,
    { timeout: 20_000 },
  )
  // Tap the same cell — selection stays, preview re-activates.
  await page.locator('[data-canvas-inner]').click({ position: { x: 200, y: 200 } })
  await waitForSettled(page)
  const state = await page.evaluate(() => {
    const context = window.__appContext!
    return {
      selection: context.app.selection,
      previewTarget: context.previewTargetCellId(),
    }
  })
  expect(state.selection).not.toBeNull()
  expect(state.selection!.preview).toBe(true)
  expect(state.previewTarget).not.toBeNull()
})
