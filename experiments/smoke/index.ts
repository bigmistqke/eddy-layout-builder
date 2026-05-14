// smoke — the fastest possible check that the device will hand us a
// camera + mic stream. No recording, no measurement: getUserMedia,
// report, done in well under a second. Run this to verify the on-device
// harness (Chrome socket, permissions, foreground tab) before spending
// time on a real experiment. See README.md.

import { reportResult, status } from "../harness/report"

const params = { constraints: { video: true, audio: true } }

async function run(): Promise<void> {
  status("requesting camera + mic...")
  try {
    const stream = await navigator.mediaDevices.getUserMedia(params.constraints)
    const video = stream.getVideoTracks()[0]
    const settings = video?.getSettings() ?? {}
    for (const track of stream.getTracks()) {
      track.stop()
    }
    reportResult("smoke", params, {
      camera: "ok",
      videoLabel: video?.label ?? null,
      width: settings.width ?? null,
      height: settings.height ?? null,
    })
  } catch (error) {
    reportResult("smoke", params, {
      camera: "denied",
      name: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

void run()
