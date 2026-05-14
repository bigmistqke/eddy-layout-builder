import { defineConfig } from "@playwright/test"

/**
 * Run the existing test suite against a USB-connected Android Chrome
 * via the Chrome DevTools Protocol. Tests are unmodified — the page
 * fixture in tests/_android-fixture.ts replaces the launched-browser
 * page with one created in the phone's existing context.
 *
 * Run via `pnpm test:android` (which sets up adb plumbing too).
 */
process.env.PLAYWRIGHT_ANDROID = "1"

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./tests/android-setup.ts",
  fullyParallel: false,
  retries: 0,
  // Only one phone — must serialise.
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5174",
    // No viewport override: the phone's real viewport is used.
    // No launchOptions: the browser is the phone's Chrome, attached
    // via CDP in the fixture.
    trace: "on-first-retry",
  },
  webServer: {
    command: "pnpm run preview:test",
    url: "http://localhost:5174",
    reuseExistingServer: true,
    timeout: 30_000,
  },
})
