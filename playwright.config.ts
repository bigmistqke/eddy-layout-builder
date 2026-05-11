import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  retries: 0,
  workers: 1,
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
    // Dedicated test server on port 5174 so tests can run alongside a
    // local `pnpm dev` (port 5173) without port conflicts. With
    // reuseExistingServer, consecutive test runs reuse a still-running
    // 5174 server instead of failing on port-in-use.
    command: "pnpm run dev:test",
    url: "http://localhost:5174",
    reuseExistingServer: true,
    timeout: 30_000,
  },
})
