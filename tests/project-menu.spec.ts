import { expect, test } from "./helpers"

test("project menu: hamburger opens dialog with Export option", async ({ page }) => {
  await page.goto("/")
  await expect(page.locator("[data-action='open-project-menu']")).toBeVisible()

  const dialog = page.locator("[data-testid='project-menu']")
  await expect(dialog).toBeHidden()

  await page.locator("[data-action='open-project-menu']").click()
  await expect(dialog).toBeVisible()
  await expect(dialog.locator("[data-action='export']")).toBeVisible()

  await page.keyboard.press("Escape")
  await expect(dialog).toBeHidden()
})

test("project menu: backdrop click closes dialog", async ({ page }) => {
  await page.goto("/")
  await page.locator("[data-action='open-project-menu']").click()
  const dialog = page.locator("[data-testid='project-menu']")
  await expect(dialog).toBeVisible()

  // Native <dialog> showModal renders ::backdrop; clicks on the
  // dialog area outside the content target the dialog element itself.
  // Click at viewport (10,10) — likely outside the centered dialog box.
  await page.mouse.click(10, 10)
  await expect(dialog).toBeHidden()
})

test("project menu: hamburger stays visible without a selection", async ({ page }) => {
  await page.goto("/")
  // Deselect by tapping the selected (root) cell.
  const wrapper = page.locator("[data-canvas-inner]")
  const box = await wrapper.boundingBox()
  if (box === null) throw new Error("canvas not visible")
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  // Hamburger is in its own always-mounted menu HUD; the contextual
  // tool-bar (which carries delete) only mounts in edit mode.
  await expect(page.locator("[data-action='open-project-menu']")).toBeVisible()
  await expect(page.locator("[data-action='delete']")).toHaveCount(0)
})
