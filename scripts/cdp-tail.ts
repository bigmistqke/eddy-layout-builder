#!/usr/bin/env node
// Attach to a Chrome DevTools Protocol tab over websocket and stream
// console messages + uncaught exceptions to stdout. Pair with
// scripts/android-debug.sh to debug the app on a USB-connected phone
// without needing chrome://inspect open.
//
// Usage:
//   scripts/cdp-tail.ts                                 # pick tab matching $URL_MATCH (default: 'eddy') from http://localhost:9222
//   URL_MATCH=localhost scripts/cdp-tail.ts             # pick first tab whose URL contains 'localhost'
//   scripts/cdp-tail.ts ws://localhost:9222/devtools/page/161   # explicit ws URL

const CDP_PORT = process.env.CDP_PORT ?? "9222"
const URL_MATCH = process.env.URL_MATCH ?? "eddy"

async function pickTab() {
  if (process.argv[2]?.startsWith("ws://")) {
    return process.argv[2]
  }
  const res = await fetch(`http://localhost:${CDP_PORT}/json`)
  const tabs = await res.json()
  const tab = tabs.find(t => t.type === "page" && t.url.includes(URL_MATCH))
  if (!tab) {
    console.error(`no tab matching '${URL_MATCH}'. open the app on the phone first.`)
    console.error("available tabs:")
    for (const t of tabs) console.error(`  ${t.type}  ${t.url}`)
    process.exit(1)
  }
  console.error(`attaching: ${tab.url}`)
  return tab.webSocketDebuggerUrl
}

function fmtRemote(r) {
  if (r.type === "string") return JSON.stringify(r.value)
  if ("value" in r) return String(r.value)
  if (r.description) return r.description
  return r.type
}

function ts() {
  return new Date().toISOString().slice(11, 23)
}

const wsUrl = await pickTab()
const ws = new WebSocket(wsUrl)

let nextId = 1
const send = (method, params = {}) =>
  ws.send(JSON.stringify({ id: nextId++, method, params }))

ws.addEventListener("open", () => {
  send("Runtime.enable")
  send("Log.enable")
  send("Page.enable")
  console.error(`[${ts()}] connected — listening for console + exceptions (Ctrl-C to stop)`)
})

ws.addEventListener("message", ev => {
  const msg = JSON.parse(ev.data)
  if (!msg.method) return
  if (msg.method === "Runtime.consoleAPICalled") {
    const { type, args, stackTrace } = msg.params
    const parts = args.map(fmtRemote).join(" ")
    console.log(`[${ts()}] console.${type}: ${parts}`)
    if (type === "error" && stackTrace) {
      for (const f of stackTrace.callFrames.slice(0, 3)) {
        console.log(`            at ${f.functionName || "<anon>"} (${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1})`)
      }
    }
  } else if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails
    const desc = d.exception?.description ?? d.text
    console.log(`[${ts()}] UNCAUGHT: ${desc}`)
  } else if (msg.method === "Log.entryAdded") {
    const e = msg.params.entry
    console.log(`[${ts()}] log.${e.level} (${e.source}): ${e.text}`)
  } else if (msg.method === "Page.frameNavigated" && msg.params.frame.parentId === undefined) {
    console.log(`[${ts()}] nav -> ${msg.params.frame.url}`)
  }
})

ws.addEventListener("close", () => {
  console.error(`[${ts()}] disconnected`)
  process.exit(0)
})
ws.addEventListener("error", e => {
  console.error("ws error:", e.message ?? e)
})
