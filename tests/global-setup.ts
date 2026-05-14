import { chromium } from "@playwright/test"

/**
 * Touch the preview server once so the dev/build server is warm before
 * tests run. Cheap insurance against first-touch latency.
 */
export default async function globalSetup() {
  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.goto("http://localhost:5184")
  await page.waitForTimeout(500)
  await browser.close()
}
