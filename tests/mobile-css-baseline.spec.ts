import { expect, mockGetUserMedia, test } from "./helpers"

// A15-equivalent viewport (matches what the visual companion reports
// for the device used across the 30-series experiments).
test.use({ viewport: { width: 384, height: 699 } })

test("mobile baseline: viewport meta is honored, touch targets ≥ 44px, dialog respects dvh", async ({
  page,
}) => {
  await mockGetUserMedia(page)
  await page.goto("/")

  // 1) Viewport meta tag honored: documentElement.clientWidth must
  // equal the actual viewport width. Without the meta tag, mobile
  // browsers internally render at ~980px and clientWidth reports the
  // wider value. (Playwright's Chromium honors the meta tag, so this
  // assertion fails if the tag is missing or misconfigured.)
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth)
  expect(clientWidth).toBe(384)

  // 2) Record-start button is a meaningful touch target (WCAG 2.5.5
  // recommends 44×44 CSS pixels minimum). At the 16px rem base and
  // --hud-height: 3.75rem, the button is 60×60 CSS px.
  // Wait for the button to be visible explicitly — under full-suite
  // run with stateful OPFS leak from prior tests, the app may take
  // longer to mount the record button than in isolation.
  const recordButton = page.locator('[data-action="record-start"]').first()
  await recordButton.waitFor({ state: "visible", timeout: 10_000 })
  const boundingBox = await recordButton.boundingBox()
  expect(boundingBox).not.toBeNull()
  expect(boundingBox!.width).toBeGreaterThanOrEqual(44)
  expect(boundingBox!.height).toBeGreaterThanOrEqual(44)

  // 3) The project-menu dialog respects the dvh-based max-height.
  // Open it via the menu button and assert it doesn't exceed the
  // viewport's 80dvh.
  await page.locator('[data-action="open-project-menu"]').click()
  const dialog = page.locator("[data-testid='project-menu']")
  await expect(dialog).toBeVisible()
  const dialogBox = await dialog.boundingBox()
  expect(dialogBox).not.toBeNull()
  // dvh in headless Chromium resolves to the configured viewport
  // height, so 80dvh = 559.2 px. Allow a 5px slack for borders.
  expect(dialogBox!.height).toBeLessThanOrEqual(699 * 0.8 + 5)
})
