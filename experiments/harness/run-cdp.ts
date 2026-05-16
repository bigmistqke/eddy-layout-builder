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
//   node experiments/harness/run-cdp.ts <experiment-name> <port>
// (Node runs .ts directly; the repo is "type": "module".)

import { execSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const [, , experiment, portArg] = process.argv
if (!experiment) {
  console.error("usage: run-cdp.ts <experiment-name> [port]")
  process.exit(2)
}
const port = portArg ?? "5173"
const CDP = "http://localhost:9222"
const PAGE_URL = `http://localhost:${port}/experiments/index.html?experiment=${experiment}`
// Override with TIMEOUT_MS=300000 etc. for long-running experiments
// (e.g. 18_progressive-record runs ~120s for the 9-stage session).
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 180_000)
const RESULT_PREFIX = "[experiment-result] "
// experiments/harness/ → experiments/
const EXPERIMENTS_DIR = dirname(import.meta.dirname)

function gitMeta(): { sha: string | null; dirty: boolean | null } {
  try {
    const sha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim()
    const dirty = execSync("git status --porcelain", { encoding: "utf8" }).trim().length > 0
    return { sha, dirty }
  } catch {
    return { sha: null, dirty: null }
  }
}

interface CdpConnection {
  ws: WebSocket
  ready: Promise<void>
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  close(): void
}

/** Open a CDP websocket and return a `send(method, params)` helper plus
 *  the raw socket (for event listeners) and a ready promise. */
function connect(wsUrl: string): CdpConnection {
  const ws = new WebSocket(wsUrl)
  let nextId = 1
  const pending = new Map<number, PromiseWithResolvers<unknown>>()
  ws.addEventListener("message", ev => {
    const msg = JSON.parse(ev.data as string)
    // A Chrome crash can surface as a CDP message error ("Target
    // crashed") rather than a socket close — treat it the same: exit 3
    // so run.sh relaunches and retries, instead of an unhandled
    // rejection that would die with exit 1 ("not a crash, giving up").
    const errorText = msg.error ? JSON.stringify(msg.error) : ""
    if (errorText.includes("crashed")) {
      console.error("[run-cdp] CDP reported a target crash — Chrome crash")
      process.exit(3)
    }
    const call = msg.id !== undefined ? pending.get(msg.id) : undefined
    if (call) {
      pending.delete(msg.id)
      msg.error ? call.reject(new Error(errorText)) : call.resolve(msg.result)
    }
  })
  const ready = Promise.withResolvers<void>()
  ws.addEventListener("open", () => ready.resolve())
  ws.addEventListener("error", () => ready.reject(new Error("websocket error")))
  function send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = nextId++
    const call = Promise.withResolvers<unknown>()
    pending.set(id, call)
    ws.send(JSON.stringify({ id, method, params }))
    return call.promise
  }
  return { ws, ready: ready.promise, send, close: () => ws.close() }
}

async function pickPageTab(): Promise<{ ws: string; fresh: boolean }> {
  // Android Chrome usually disables /json/new — fall back to navigating
  // the first existing page tab.
  try {
    const res = await fetch(`${CDP}/json/new?${encodeURIComponent(PAGE_URL)}`, { method: "PUT" })
    if (res.ok) {
      return { ws: (await res.json()).webSocketDebuggerUrl, fresh: true }
    }
  } catch {}
  const tabs = await (await fetch(`${CDP}/json`)).json()
  const existing = tabs.find(
    (tab: { type: string; webSocketDebuggerUrl?: string }) =>
      tab.type === "page" && tab.webSocketDebuggerUrl,
  )
  if (!existing) {
    throw new Error("no usable page tab on the device")
  }
  return { ws: existing.webSocketDebuggerUrl, fresh: false }
}

// If Chrome is dead when we start (crashed before run-cdp launched), the
// CDP endpoint refuses — treat that as a crash (exit 3) so run.sh
// relaunches and retries, rather than a hard failure.
const { ws: pageWsUrl, fresh } = await pickPageTab().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[run-cdp] cannot reach CDP — Chrome crash? (${message})`)
  process.exit(3)
})
console.error(`[run-cdp] ${experiment} → ${PAGE_URL}`)
console.error(`[run-cdp] target tab (${fresh ? "fresh" : "reused"}): ${pageWsUrl}`)
const page = connect(pageWsUrl)
page.ready.catch(() => {
  console.error("[run-cdp] page socket failed to open — Chrome crash?")
  process.exit(3)
})

let captured = false
const { promise: done, resolve: resolveDone } = Promise.withResolvers<void>()
page.ws.addEventListener("message", ev => {
  const msg = JSON.parse(ev.data as string)
  if (msg.method !== "Runtime.consoleAPICalled") {
    return
  }
  const text: string = (msg.params.args ?? [])
    .map((arg: { value?: unknown; description?: string }) => arg.value ?? arg.description ?? "")
    .join(" ")
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
  captured = true
  resolveDone()
})

// Chrome crashing mid-run (OOM under many decoders, thermal, etc.) drops
// the page's DevTools socket. Exit 3 so run.sh knows it was a crash and
// relaunches Chrome for another attempt — distinct from a clean timeout.
page.ws.addEventListener("close", () => {
  if (!captured) {
    console.error("[run-cdp] target socket closed before a result — Chrome crash?")
    process.exit(3)
  }
})

// Inspector.targetCrashed is the canonical renderer-crash signal — it
// usually fires several seconds before the socket close does, so reacting
// to it shortens the OOM-detect latency from "wait for socket / 3-min
// timeout" to immediate. Inspector.targetReloadedAfterCrash means Chrome
// auto-reloaded the page after a crash, also a hard fail for this run.
page.ws.addEventListener("message", ev => {
  const msg = JSON.parse(ev.data as string)
  if (msg.method === "Inspector.targetCrashed" || msg.method === "Inspector.targetReloadedAfterCrash") {
    if (!captured) {
      console.error(`[run-cdp] ${msg.method} — Chrome renderer crash`)
      process.exit(3)
    }
  }
  // Surface uncaught exceptions from the device so a silent timeout has a
  // visible cause. Doesn't change the exit path (the experiment's own
  // catch handler usually still reports a result); just makes failures
  // diagnosable instead of mysterious.
  if (msg.method === "Runtime.exceptionThrown") {
    const detail = msg.params?.exceptionDetails
    const text = detail?.exception?.description ?? detail?.text ?? "(no detail)"
    console.error(`[device-exception] ${text}`)
  }
})

await page.ready
await page.send("Page.enable")
// Inspector domain emits targetCrashed / targetReloadedAfterCrash —
// the canonical renderer-crash events, listened for above.
await page.send("Inspector.enable").catch(() => {})
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
