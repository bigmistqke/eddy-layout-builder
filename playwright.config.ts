import { resolve } from "path"
import { defineConfig } from "@playwright/test"

void resolve

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./tests/global-setup.ts",
  // Workers share the single webServer. Tests are isolated per page/
  // browser-context, so parallelism is safe here.
  // Workers share the single webServer. Tests are isolated per page/
  // browser-context, but layout-tween and record-stop timing become
  // flaky under CPU contention at workers > 1. Sticking with 1 worker
  // until those tests are made resilient to parallelism.
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    // Port 5184 (not the default 5174) so this worktree's test server
    // never collides with the main checkout or another worktree —
    // avoids stale-server ERR_CONNECTION_REFUSED flakes.
    baseURL: "http://localhost:5184",
    headless: true,
    viewport: { width: 1280, height: 800 },
    trace: "on-first-retry",
    launchOptions: {
      args: [
        "--autoplay-policy=no-user-gesture-required",
        // Chromium ships a fake camera (color bars + tone) when this
        // flag is set. Without it, gUM rejects with NotSupportedError
        // in headless and the rejection wraps as a Solid StatusError
        // that corrupts sibling JSX renders. Tests that need a
        // *specific* recorded fixture still call mockGetUserMedia
        // explicitly — this is just the silent fallback.
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
      ],
    },
  },
  webServer: {
    // Tests run against the production build (`vite preview`), not the
    // dev server. Reason: the dev server lazy-optimizes deps on first
    // request, which made the first test to hit mediabunny / view.gl
    // timing-sensitive and prone to flakes. The build is static and
    // deterministic. `pnpm test` runs `vite build && playwright test`,
    // so the build is fresh on every test run.
    command: "pnpm run preview:test",
    url: "http://localhost:5184",
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
