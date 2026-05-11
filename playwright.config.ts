import { resolve } from "path"
import { defineConfig } from "@playwright/test"

void resolve

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./tests/global-setup.ts",
  // Workers share the single webServer. Tests are isolated per page/
  // browser-context, so parallelism is safe here.
  // Workers share the single webServer. Tests are isolated per page/
  // browser-context. Two workers gives a meaningful speedup; more
  // pushes timing-sensitive tests (record auto-stop, layout tweens)
  // into flake territory under CPU contention.
  fullyParallel: true,
  retries: 0,
  workers: 2,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5174",
    headless: true,
    viewport: { width: 1280, height: 800 },
    trace: "on-first-retry",
    launchOptions: {
      args: ["--autoplay-policy=no-user-gesture-required"],
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
    url: "http://localhost:5174",
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
