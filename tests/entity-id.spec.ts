import { expect, test } from "./helpers"

test("entity carries a stable uuid id", async ({ page }) => {
  await page.goto("/")
  const rootId = await page.evaluate(() => {
    const layout = window.__appContext?.app.layout
    return layout?.type === "entity" ? layout.id : null
  })
  expect(rootId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
})
