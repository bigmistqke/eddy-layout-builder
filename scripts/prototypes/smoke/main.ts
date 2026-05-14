// Smoke test — the fastest possible check that the device will hand us a
// camera + mic stream. No recording, no demux, no measurements: call
// getUserMedia, report the outcome, done in well under a second. Use this
// to iterate on the on-device permission setup before running a real
// prototype.
//
// Reports `[prototype-result] {...}` either way so run-cdp.mjs returns
// immediately instead of waiting out its timeout.

const RESULT_PREFIX = "[prototype-result]"
const statusElement = document.querySelector<HTMLPreElement>("#status")!
const grantButton = document.querySelector<HTMLButtonElement>("#grant")!

function report(result: Record<string, unknown>): void {
  const text = JSON.stringify(result)
  statusElement.textContent = JSON.stringify(result, null, 2)
  console.log(`${RESULT_PREFIX} ${text}`)
}

async function check(trigger: "auto" | "tap"): Promise<void> {
  statusElement.textContent = `smoke — requesting camera + mic (${trigger})...`
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
    const video = stream.getVideoTracks()[0]
    const settings = video?.getSettings() ?? {}
    for (const track of stream.getTracks()) {
      track.stop()
    }
    report({
      camera: "ok",
      trigger,
      videoLabel: video?.label ?? null,
      width: settings.width ?? null,
      height: settings.height ?? null,
      origin: location.origin,
    })
  } catch (error) {
    report({
      camera: "denied",
      trigger,
      name: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message : String(error),
      origin: location.origin,
    })
  }
}

// A tap-driven retry path: if the auto attempt is denied, a real user
// gesture (or an adb/CDP synthetic tap on this button) gets a second
// shot — Android Chrome only shows the permission prompt under one.
grantButton.addEventListener("click", () => {
  void check("tap")
})

void check("auto")
