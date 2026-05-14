// CDP half of the prototype runner: connect to Android Chrome over the
// forwarded :9222, grant camera+mic for the prototype origin, navigate
// to the prototype page, stream its console, and print the
// [prototype-result] JSON when it arrives.
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

async function pickTarget() {
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

const { ws: wsUrl, fresh } = await pickTarget()
console.error(`[run-cdp] ${prototype} → ${PAGE_URL}`)
console.error(`[run-cdp] target tab (${fresh ? "fresh" : "reused"}): ${wsUrl}`)

const ws = new WebSocket(wsUrl)
let nextId = 1
const pending = new Map()
function send(method, params = {}) {
  const id = nextId++
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

let resolveDone
const done = new Promise(resolve => (resolveDone = resolve))

ws.addEventListener("message", ev => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    return
  }
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

await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve)
  ws.addEventListener("error", reject)
})

await send("Runtime.enable")
await send("Page.enable")
await send("Browser.grantPermissions", {
  origin: ORIGIN,
  permissions: ["videoCapture", "audioCapture"],
})
console.error("[run-cdp] permissions granted, navigating...")
await send("Page.navigate", { url: PAGE_URL })

const timeout = setTimeout(() => {
  console.error(`[run-cdp] TIMEOUT — no [prototype-result] within ${TIMEOUT_MS / 1000}s`)
  process.exit(1)
}, TIMEOUT_MS)
await done
clearTimeout(timeout)
ws.close()
process.exit(0)
