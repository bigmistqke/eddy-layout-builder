// CDP half of the prototype runner: connect to Android Chrome over the
// forwarded :9222, grant camera+mic for the prototype origin, navigate
// to the prototype page, stream its console, and print the
// [prototype-result] JSON when it arrives.
//
// Camera/mic on Android Chrome: NO CDP command (page- or browser-level
// grantPermissions, userGesture, etc.) can grant a site's camera here —
// it requires one physical "Allow" tap on the device. That grant IS
// persistent per origin, so it's a one-time cost. Critically, do NOT
// call Browser.resetPermissions — it wipes that manual grant. (OS-level
// app permissions are handled separately by run.sh via `pm grant`.)
//
// Invoked by run.sh (which handles the adb plumbing). Standalone usage:
//   node scripts/prototypes/run-cdp.mjs <prototype-name> <port>

const [, , prototype, portArg] = process.argv
if (!prototype) {
  console.error("usage: run-cdp.mjs <prototype-name> [port]")
  process.exit(2)
}
const port = portArg ?? "5173"
const CDP = "http://localhost:9222"
const PAGE_URL = `http://localhost:${port}/scripts/prototypes/${prototype}/index.html`
const ORIGIN = `http://localhost:${port}`
const TIMEOUT_MS = 180_000

/** Open a CDP websocket and return a `send(method, params)` helper plus
 *  the raw socket (for event listeners) and a close fn. */
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

// --- Page-level: navigate + stream console. ---
const { ws: pageWsUrl, fresh } = await pickPageTab()
console.error(`[run-cdp] ${prototype} → ${PAGE_URL}`)
console.error(`[run-cdp] target tab (${fresh ? "fresh" : "reused"}): ${pageWsUrl}`)
const page = connect(pageWsUrl)

let resolveDone
const done = new Promise(resolve => (resolveDone = resolve))
page.ws.addEventListener("message", ev => {
  const msg = JSON.parse(ev.data)
  if (msg.method === "Runtime.consoleAPICalled") {
    const text = (msg.params.args || []).map(a => a.value ?? a.description ?? "").join(" ")
    console.error(`[device] ${text}`)
    const marker = "[prototype-result] "
    const at = text.indexOf(marker)
    if (at !== -1) {
      console.log(text.slice(at + marker.length))
      resolveDone()
    }
  }
})

await page.ready
await page.send("Runtime.enable")
await page.send("Page.enable")
console.error("[run-cdp] navigating...")
await page.send("Page.navigate", { url: PAGE_URL })

const timeout = setTimeout(() => {
  console.error(`[run-cdp] TIMEOUT — no [prototype-result] within ${TIMEOUT_MS / 1000}s`)
  process.exit(1)
}, TIMEOUT_MS)
await done
clearTimeout(timeout)
page.close()
process.exit(0)
