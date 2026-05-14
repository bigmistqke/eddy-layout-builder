import { execFileSync } from "child_process"

/**
 * Playwright globalSetup for the Android config. Wires up the adb
 * tunnels so the phone can reach the desktop vite preview server, and
 * the desktop can reach the phone's Chrome DevTools endpoint. Verifies
 * the CDP endpoint is alive before tests start.
 */
const CDP_PORT = Number(process.env.CDP_PORT ?? "9222")
const TEST_PORT = Number(process.env.TEST_PORT ?? "5174")
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${TEST_PORT}`
const PKG = process.env.ANDROID_CHROME_PKG ?? "com.android.chrome"

function adb(...args: string[]): string {
  return execFileSync("adb", args, { encoding: "utf-8" }).trim()
}

function findChromeSocket(): string | null {
  const lines = adb("shell", "cat", "/proc/net/unix").split("\n")
  const sockets = lines
    .map(l => l.trim().split(/\s+/).pop() ?? "")
    .filter(s => s.startsWith("@chrome_devtools_remote"))
  if (sockets.length === 0) {
    return null
  }
  // Prefer the suffixed-by-pid form if both exist; fall back to the
  // bare `@chrome_devtools_remote`.
  const pidSocket = sockets.find(s => /_\d+$/.test(s))
  return (pidSocket ?? sockets[0]).slice(1)
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForChromeSocket(timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last: string | null = null
  while (Date.now() < deadline) {
    last = findChromeSocket()
    if (last !== null) {
      return last
    }
    await wait(300)
  }
  throw new Error("android-setup: chrome_devtools_remote socket never appeared")
}

export default async function globalSetup() {
  try {
    adb("get-state")
  } catch {
    throw new Error("android-setup: no authorised adb device. Plug the phone in and accept USB-debugging.")
  }

  // Reverse first so the URL we're about to launch is reachable.
  try { adb("reverse", "--remove", `tcp:${TEST_PORT}`) } catch {}
  adb("reverse", `tcp:${TEST_PORT}`, `tcp:${TEST_PORT}`)
  console.log(`[android-setup] reverse: phone localhost:${TEST_PORT} -> desktop :${TEST_PORT}`)

  // Launch Chrome on the test URL. This both foregrounds Chrome (so
  // its CDP socket comes up) and parks it on the right origin so the
  // first test's grantPermissions call has somewhere to take effect.
  adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", BASE_URL, PKG)
  console.log(`[android-setup] launched ${PKG} on ${BASE_URL}`)

  const socket = await waitForChromeSocket(5000)
  console.log(`[android-setup] chrome socket: @${socket}`)

  try { adb("forward", "--remove", `tcp:${CDP_PORT}`) } catch {}
  adb("forward", `tcp:${CDP_PORT}`, `localabstract:${socket}`)
  console.log(`[android-setup] forward: desktop :${CDP_PORT} -> phone @${socket}`)

  // Probe CDP. The socket sometimes accepts connections for a beat
  // before answering HTTP — retry a few times.
  let lastError: unknown = null
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(`http://localhost:${CDP_PORT}/json/version`)
      if (res.ok) {
        const info = (await res.json()) as { Browser?: string }
        console.log(`[android-setup] CDP ok: ${info.Browser ?? "?"}`)
        return
      }
      lastError = new Error(`status ${res.status}`)
    } catch (error) {
      lastError = error
    }
    await wait(500)
  }
  throw new Error(`android-setup: CDP at localhost:${CDP_PORT} not responding: ${lastError}`)
}
