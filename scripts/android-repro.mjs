#!/usr/bin/env node
// Drive a single record-start / record-stop cycle on the Android Chrome
// tab attached over CDP. Reports every `[trace]`, `[action]`, `[error]`
// console line and any uncaught exception, then waits for either
// `record-stop-complete` (success), an `[error]` (handled failure),
// `pageerror` (unhandled failure), or a timeout.
//
// Prereq: scripts/android-debug.sh has wired up adb forward/reverse and
// the phone has http://localhost:5173/ open.
//
// Usage:
//   pnpm exec node scripts/android-repro.mjs
//   HOLD_MS=2000 pnpm exec node scripts/android-repro.mjs   # record duration

import { chromium } from "@playwright/test"

const CDP_URL = process.env.CDP_URL ?? "http://localhost:9222"
const PAGE_URL_MATCH = process.env.PAGE_URL_MATCH ?? "localhost:5173"
const HOLD_MS = Number(process.env.HOLD_MS ?? "1500")
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? "20000")

function ts() {
  return new Date().toISOString().slice(11, 23)
}

const browser = await chromium.connectOverCDP(CDP_URL)
const [context] = browser.contexts()
if (!context) {
  console.error("no browser context — is Chrome open on the phone?")
  process.exit(1)
}

// gUM permission: pre-grant so the test never blocks on a permission
// dialog. The origin must match the page exactly.
const origin = `http://${PAGE_URL_MATCH.split("/")[0]}`
try {
  await context.grantPermissions(["camera", "microphone"], { origin })
  console.error(`[${ts()}] granted camera + microphone to ${origin}`)
} catch (e) {
  console.error(`[${ts()}] grantPermissions failed: ${e.message}`)
}

const page = context.pages().find(p => p.url().includes(PAGE_URL_MATCH))
if (!page) {
  console.error(`no page matching '${PAGE_URL_MATCH}'. open it on the phone first.`)
  console.error("pages:", context.pages().map(p => p.url()))
  process.exit(1)
}
console.error(`[${ts()}] attached to ${page.url()}`)

// Hard reload to guarantee we're running the latest code, not whatever
// stale HMR snapshot was last applied. Wait for `[init]` so the app has
// booted before we start clicking.
const reloadInit = page.waitForEvent("console", { predicate: m => m.text().startsWith("[init]"), timeout: 10_000 })
await page.reload()
await reloadInit

const events = []
page.on("console", msg => {
  const text = msg.text()
  events.push({ ts: ts(), kind: "console", level: msg.type(), text })
  console.log(`[${ts()}] ${msg.type()}: ${text}`)
})
page.on("pageerror", err => {
  events.push({ ts: ts(), kind: "pageerror", text: err.stack ?? err.message })
  console.log(`[${ts()}] PAGEERROR: ${err.stack ?? err.message}`)
})

// Wait for the record-start button to become enabled (preview.stream resolved).
console.error(`[${ts()}] waiting for record-start to enable...`)
try {
  await page.locator('[data-action="record-start"]:not([disabled])').waitFor({ timeout: 10_000 })
} catch {
  console.error(`[${ts()}] record-start never enabled — preview.stream likely failed`)
  console.error(`[${ts()}] dumping last events:`)
  for (const e of events.slice(-20)) console.error("  ", JSON.stringify(e))
  process.exit(2)
}

console.error(`[${ts()}] tapping record-start`)
await page.locator('[data-action="record-start"]').click()

await page.waitForTimeout(HOLD_MS)

console.error(`[${ts()}] tapping record-stop`)
await page.locator('[data-action="record-stop"]').click()

// Wait for one of: completion trace, handled error, page error, timeout.
const outcome = await Promise.race([
  page.waitForFunction(
    () =>
      window.__appContext &&
      Object.keys(window.__appContext.clips.clips ?? {}).length > 0,
    null,
    { timeout: TIMEOUT_MS },
  ).then(() => "clip-landed").catch(() => null),
  new Promise(resolve => {
    const i = setInterval(() => {
      const errored = events.find(e => e.text?.startsWith("[error]") || e.kind === "pageerror")
      if (errored) {
        clearInterval(i)
        resolve("error-observed")
      }
    }, 100)
    setTimeout(() => {
      clearInterval(i)
      resolve("timeout")
    }, TIMEOUT_MS)
  }),
])

console.error(`[${ts()}] outcome: ${outcome}`)

// Pull final state for the summary.
const state = await page.evaluate(() => ({
  clipCount: Object.keys(window.__appContext?.clips.clips ?? {}).length,
  songLength: window.__appContext?.songLength?.() ?? null,
  transportState: window.__appContext?.transport?.state?.() ?? null,
}))
console.error(`[${ts()}] state: ${JSON.stringify(state)}`)

await browser.close()
process.exit(outcome === "clip-landed" ? 0 : 1)
