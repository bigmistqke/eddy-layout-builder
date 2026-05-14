// CDP half of the experiment runner: connect to Android Chrome over the
// forwarded :9222, navigate to the experiment in the shared shell,
// stream its console, and on the [experiment-result] line write
// experiments/<name>/result.json — wrapped with git + timestamp
// metadata so the run is reproducible.
//
// Camera/mic on Android Chrome: NO CDP command (grantPermissions,
// userGesture, etc.) can grant a site's camera here — it needs one
// physical "Allow" tap on the device, which IS persistent per origin.
// Do NOT call Browser.resetPermissions — it wipes that manual grant.
// OS-level app permissions are handled by run.sh via `pm grant`.
//
// Invoked by run.sh (which handles the adb plumbing). Standalone usage:
//   node experiments/harness/run-cdp.mjs <experiment-name> <port>

import { execSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const [, , experiment, portArg] = process.argv
if (!experiment) {
  console.error("usage: run-cdp.mjs <experiment-name> [port]")
  process.exit(2)
}
const port = portArg ?? "5173"
const CDP = "http://localhost:9222"
const PAGE_URL = `http://localhost:${port}/experiments/index.html?experiment=${experiment}`
const TIMEOUT_MS = 180_000
const RESULT_PREFIX = "[experiment-result] "
// experiments/harness/ → experiments/
const EXPERIMENTS_DIR = dirname(import.meta.dirname)

function gitMeta() {
  try {
    const sha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim()
    const dirty = execSync("git status --porcelain", { encoding: "utf8" }).trim().length > 0
    return { sha, dirty }
  } catch {
    return { sha: null, dirty: null }
  }
}

/** Open a CDP websocket and return a `send(method, params)` helper plus
 *  the raw socket (for event listeners) and a ready promise. */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let nextId = 1
  const pending = new Map()
  ws.addEventListener("message", ev => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    }
  })
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve)
    ws.addEventListener("error", reject)
  })
  function send(method, params = {}) {
    const id = nextId++
    ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  }
  return { ws, ready, send, close: () => ws.close() }
}

async function pickPageTab() {
  // Android Chrome usually disables /json/new — fall back to navigating
  // the first existing page tab.
  try {
    const res = await fetch(`${CDP}/json/new?${encodeURIComponent(PAGE_URL)}`, { method: "PUT" })
    if (res.ok) {
      return { ws: (await res.json()).webSocketDebuggerUrl, fresh: true }
    }
  } catch {}
  const tabs = await (await fetch(`${CDP}/json`)).json()
  const existing = tabs.find(t => t.type === "page" && t.webSocketDebuggerUrl)
  if (!existing) {
    throw new Error("no usable page tab on the device")
  }
  return { ws: existing.webSocketDebuggerUrl, fresh: false }
}

const { ws: pageWsUrl, fresh } = await pickPageTab()
console.error(`[run-cdp] ${experiment} → ${PAGE_URL}`)
console.error(`[run-cdp] target tab (${fresh ? "fresh" : "reused"}): ${pageWsUrl}`)
const page = connect(pageWsUrl)

let resolveDone
const done = new Promise(resolve => (resolveDone = resolve))
page.ws.addEventListener("message", ev => {
  const msg = JSON.parse(ev.data)
  if (msg.method !== "Runtime.consoleAPICalled") {
    return
  }
  const text = (msg.params.args || []).map(a => a.value ?? a.description ?? "").join(" ")
  console.error(`[device] ${text}`)
  const at = text.indexOf(RESULT_PREFIX)
  if (at === -1) {
    return
  }
  const payload = JSON.parse(text.slice(at + RESULT_PREFIX.length))
  const record = { ranAt: new Date().toISOString(), git: gitMeta(), ...payload }
  const resultPath = join(EXPERIMENTS_DIR, experiment, "result.json")
  writeFileSync(resultPath, `${JSON.stringify(record, null, 2)}\n`)
  console.error(`[run-cdp] wrote ${resultPath}`)
  console.log(JSON.stringify(record, null, 2))
  resolveDone()
})

await page.ready
await page.send("Page.enable")
// getUserMedia is denied for non-visible tabs on Android Chrome — the
// tab must be foreground before the experiment calls it.
await page.send("Page.bringToFront").catch(() => {})
console.error("[run-cdp] navigating...")
await page.send("Page.navigate", { url: PAGE_URL })
// Enable Runtime only AFTER navigating. The runner reuses an existing
// tab, which may still hold a previous experiment's page; enabling
// Runtime first would replay that stale page's buffered
// [experiment-result] and we'd capture the wrong run.
await page.send("Runtime.enable")

const timeout = setTimeout(() => {
  console.error(`[run-cdp] TIMEOUT — no [experiment-result] within ${TIMEOUT_MS / 1000}s`)
  process.exit(1)
}, TIMEOUT_MS)
await done
clearTimeout(timeout)
page.close()
process.exit(0)
