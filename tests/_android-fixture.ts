import { chromium, test as base, type Browser, type BrowserContext } from "@playwright/test"
import type { attach as Attach } from "@introspection/playwright"
import type { consolePlugin as ConsolePlugin } from "@introspection/plugin-console"
import type { jsError as JsError } from "@introspection/plugin-js-error"
import type { network as Network } from "@introspection/plugin-network"
import type { performance as PerformancePlugin } from "@introspection/plugin-performance"

// Introspection packages are ESM-only; Playwright's TS test loader runs
// as CJS, so we resolve them lazily via dynamic import on first use.
// The cached promise means we pay the ESM bridge cost once per worker.
//
// We compose plugins explicitly rather than using `defaults()` because
// the default set bundles `debuggerPlugin`, which enables CDP's
// Debugger.setPauseOnExceptions — any uncaught rejection then pauses
// the page's JS thread and deadlocks Playwright's locator actions.
const introspectionDeps = (async () => {
  const [
    { attach },
    { consolePlugin },
    { jsError },
    { network },
    { performance: performancePlugin },
  ] = await Promise.all([
    import("@introspection/playwright") as Promise<{ attach: typeof Attach }>,
    import("@introspection/plugin-console") as Promise<{ consolePlugin: typeof ConsolePlugin }>,
    import("@introspection/plugin-js-error") as Promise<{ jsError: typeof JsError }>,
    import("@introspection/plugin-network") as Promise<{ network: typeof Network }>,
    import("@introspection/plugin-performance") as Promise<{ performance: typeof PerformancePlugin }>,
  ])
  return { attach, consolePlugin, jsError, network, performancePlugin }
})()

/**
 * Test fixture that runs against a USB-connected Android Chrome via the
 * Chrome DevTools Protocol instead of launching a local browser. The
 * page is created fresh per test inside the phone's existing browser
 * context. Camera + microphone permissions are pre-granted to skip the
 * native prompt.
 *
 * Activated by playwright.android.config.ts via PLAYWRIGHT_ANDROID=1.
 * Prereqs (set up by scripts/android-test.sh):
 *   - adb device connected and authorised
 *   - adb forward tcp:9222 -> phone Chrome devtools socket
 *   - adb reverse tcp:5174 -> desktop vite preview server
 *   - Chrome in foreground on the phone
 */
const CDP_URL = process.env.CDP_URL ?? "http://localhost:9222"
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5174"

export const androidTest = base.extend<object, { androidBrowser: Browser; androidContext: BrowserContext }>(
  {
    androidBrowser: [
      async ({}, use) => {
        const browser = await chromium.connectOverCDP(CDP_URL)
        await use(browser)
        await browser.close()
      },
      { scope: "worker" },
    ],
    androidContext: [
      async ({ androidBrowser }, use) => {
        const contexts = androidBrowser.contexts()
        const context = contexts[0]
        if (!context) {
          throw new Error("android: no browser context — is Chrome open on the phone?")
        }
        const origin = new URL(BASE_URL).origin
        await context.grantPermissions(["camera", "microphone"], { origin })
        await use(context)
      },
      { scope: "worker" },
    ],
    page: async ({ androidContext }, use, testInfo) => {
      const page = await androidContext.newPage()
      // We share one phone Chrome profile across the whole run, so OPFS
      // (and indexeddb/localStorage) would leak between tests. Wipe per
      // origin via the CDP Storage domain before each test starts.
      const cdp = await androidContext.newCDPSession(page)
      try {
        await cdp.send("Storage.clearDataForOrigin", {
          origin: new URL(BASE_URL).origin,
          storageTypes: "file_systems,indexeddb,local_storage,cache_storage,service_workers",
        })
      } catch (error) {
        console.warn("[android-fixture] storage wipe failed:", (error as Error).message)
      }
      // page.goto() inherits baseURL from the context Playwright creates
      // itself; attached-over-CDP contexts don't carry that option, so
      // relative URLs fail with "Cannot navigate to invalid URL". Resolve
      // against BASE_URL ourselves so tests can keep using `page.goto("/")`.
      const originalGoto = page.goto.bind(page)
      page.goto = (url, options) => {
        const resolved = /^https?:/.test(url) ? url : new URL(url, BASE_URL).href
        return originalGoto(resolved, options)
      }

      // Attach introspection: console output, JS errors, network, and
      // performance metrics (CWV, long tasks, layout shifts, paint) go
      // to a per-test session under .introspect/. Query with the
      // `introspect` CLI after the run.
      const { attach, consolePlugin, jsError, network, performancePlugin } = await introspectionDeps
      const intro = await attach(page, {
        testTitle: testInfo.title,
        titlePath: testInfo.titlePath,
        workerIndex: testInfo.workerIndex,
        plugins: [consolePlugin(), jsError(), network(), performancePlugin()],
      })

      await use(page)

      const knownStatuses = ["passed", "failed", "timedOut", "skipped"] as const
      const status = (knownStatuses as readonly string[]).includes(testInfo.status ?? "")
        ? (testInfo.status as (typeof knownStatuses)[number])
        : ("failed" as const)
      if (status !== "passed" && status !== "skipped") {
        await intro.snapshot().catch(() => {})
      }
      await intro.detach({
        status,
        duration: testInfo.duration,
        error: testInfo.error?.message,
        titlePath: testInfo.titlePath,
      }).catch(() => {})

      // Force-discard the test document before closing the tab. Without
      // this, Android Chrome's tab pool sometimes keeps the renderer
      // alive across tests and accumulates state (ImageBitmaps, OPFS
      // handles, audio nodes) until the page crashes with OOM. Loading
      // about:blank commits a new document, dropping the prior one's
      // references before page.close runs.
      await page.goto("about:blank").catch(() => {})
      await cdp.detach().catch(() => {})
      await page.close()
    },
  },
)
