// synthetic-30fps-stress — feeds the same mediabunny AV1 pipeline
// from experiment 30, but driven by a synthetic 30 fps frame generator
// (no camera) so we can measure encoder headroom without camera-side
// throttling.

import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  EncodedPacketSink,
  Input,
  Output,
  VideoSample,
  VideoSampleSource,
  WebMOutputFormat,
} from "mediabunny"
import { wait } from "../../src/utils"
import { reportResult, status } from "../harness/report"

const params = {
  captureSeconds: 10,
  targetFps: 30,
  bitratePerPixel: 0.1,
  codec: "av1" as const,
  passes: [
    { label: "720p", width: 1280, height: 720 },
    { label: "540p", width: 960, height: 544 },
    { label: "270p", width: 480, height: 272 },
    { label: "180p", width: 320, height: 184 },
  ],
}

interface PassResult {
  label: string
  width: number
  height: number
  targetFps: number
  framesSubmitted: number
  framesEncoded: number
  submittedFps: number
  encodedFps: number
  pendingAddsMax: number
  addP95Ms: number
  addMaxMs: number
  tickLagMaxMs: number
  tickLagP95Ms: number
  finalizeMs: number
  webmBytes: number
  webmBytesPerSecond: number
  roundTripDemuxed: number
  roundTripVerified: boolean
  errors: string[]
}

// Draw a frame whose pixel content actually changes — a moving
// gradient + a counter rectangle — so AV1 has real motion to encode
// (static frames would be misleadingly cheap).
function paintFrame(
  context: OffscreenCanvasRenderingContext2D,
  width: number,
  height: number,
  frameIndex: number,
): void {
  const phase = (frameIndex % 60) / 60
  const gradient = context.createLinearGradient(0, 0, width, height)
  gradient.addColorStop(0, `hsl(${(phase * 360) | 0}, 80%, 40%)`)
  gradient.addColorStop(1, `hsl(${((phase * 360 + 180) | 0) % 360}, 80%, 60%)`)
  context.fillStyle = gradient
  context.fillRect(0, 0, width, height)
  const boxSize = Math.max(20, Math.min(width, height) / 6)
  const boxX = ((frameIndex * 7) % (width - boxSize))
  const boxY = ((frameIndex * 11) % (height - boxSize))
  context.fillStyle = "#000"
  context.fillRect(boxX, boxY, boxSize, boxSize)
  context.fillStyle = "#fff"
  context.font = `${(boxSize / 2) | 0}px monospace`
  context.fillText(String(frameIndex), boxX + 4, boxY + boxSize / 2)
}

async function runPass(pass: (typeof params.passes)[number]): Promise<PassResult> {
  const errors: string[] = []
  status(`PASS ${pass.label} (${pass.width}×${pass.height})`)

  const canvas = new OffscreenCanvas(pass.width, pass.height)
  const context = canvas.getContext("2d")
  if (context === null) {
    throw new Error("runPass: no 2d context")
  }

  const output = new Output({
    format: new WebMOutputFormat(),
    target: new BufferTarget(),
  })
  const bitrate = Math.round(
    pass.width * pass.height * params.targetFps * params.bitratePerPixel,
  )
  const videoSource = new VideoSampleSource({ codec: params.codec, bitrate })
  output.addVideoTrack(videoSource)
  await output.start()

  const tickIntervalMs = 1000 / params.targetFps
  const totalFrames = params.captureSeconds * params.targetFps
  const startMs = performance.now()
  let pendingAdds = 0
  let pendingAddsMax = 0
  let framesSubmitted = 0
  let framesEncoded = 0
  const addTimings: number[] = []
  const tickLags: number[] = []

  // Fire-and-track each add() — push the frame, increment pendingAdds,
  // track when it resolves. The tick loop honors the 30 fps schedule
  // regardless of encoder backpressure (this is the whole point — we
  // want to see what the encoder does when fed at full rate).
  for (let i = 0; i < totalFrames; i++) {
    const scheduledMs = startMs + i * tickIntervalMs
    const nowBeforeWait = performance.now()
    const waitMs = scheduledMs - nowBeforeWait
    if (waitMs > 0) {
      await wait(waitMs)
    }
    const nowAfterWait = performance.now()
    tickLags.push(nowAfterWait - scheduledMs)

    paintFrame(context, pass.width, pass.height, i)
    const timestampUs = Math.round((i / params.targetFps) * 1_000_000)
    const frame = new VideoFrame(canvas, { timestamp: timestampUs })
    const sample = new VideoSample(frame)

    framesSubmitted++
    pendingAdds++
    if (pendingAdds > pendingAddsMax) {
      pendingAddsMax = pendingAdds
    }
    const addStart = performance.now()
    videoSource
      .add(sample)
      .then(() => {
        addTimings.push(performance.now() - addStart)
        framesEncoded++
      })
      .catch((error: unknown) => {
        errors.push(`add: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => {
        pendingAdds--
        sample.close()
        frame.close()
      })
  }

  // Wait for all in-flight adds to drain before finalizing.
  const drainStart = performance.now()
  while (pendingAdds > 0) {
    await wait(10)
    if (performance.now() - drainStart > 60_000) {
      errors.push(`drain: still ${pendingAdds} pending after 60s, abandoning`)
      break
    }
  }

  const finalizeStart = performance.now()
  videoSource.close()
  await output.finalize()
  const finalizeMs = performance.now() - finalizeStart

  const buffer = (output.target as BufferTarget).buffer
  const webmBytes = buffer === null ? 0 : buffer.byteLength
  const webmBlob = buffer === null ? null : new Blob([buffer], { type: "video/webm" })

  let roundTripDemuxed = 0
  let roundTripVerified = false
  if (webmBlob !== null) {
    try {
      const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(webmBlob) })
      const videoTracks = await input.getVideoTracks()
      const videoTrack = videoTracks[0] ?? null
      if (videoTrack !== null) {
        const sink = new EncodedPacketSink(videoTrack)
        for await (const _packet of sink.packets()) {
          roundTripDemuxed++
        }
        roundTripVerified = roundTripDemuxed === framesEncoded
      }
    } catch (error) {
      errors.push(`roundtrip: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const sortedAdd = addTimings.slice().sort((a, b) => a - b)
  const p95AddIdx = Math.min(sortedAdd.length - 1, Math.floor(sortedAdd.length * 0.95))
  const sortedLag = tickLags.slice().sort((a, b) => a - b)
  const p95LagIdx = Math.min(sortedLag.length - 1, Math.floor(sortedLag.length * 0.95))

  const result: PassResult = {
    label: pass.label,
    width: pass.width,
    height: pass.height,
    targetFps: params.targetFps,
    framesSubmitted,
    framesEncoded,
    submittedFps: framesSubmitted / params.captureSeconds,
    encodedFps: framesEncoded / params.captureSeconds,
    pendingAddsMax,
    addP95Ms: sortedAdd.length > 0 ? sortedAdd[p95AddIdx] : 0,
    addMaxMs: sortedAdd.length > 0 ? sortedAdd[sortedAdd.length - 1] : 0,
    tickLagMaxMs: sortedLag.length > 0 ? sortedLag[sortedLag.length - 1] : 0,
    tickLagP95Ms: sortedLag.length > 0 ? sortedLag[p95LagIdx] : 0,
    finalizeMs,
    webmBytes,
    webmBytesPerSecond: webmBytes / params.captureSeconds,
    roundTripDemuxed,
    roundTripVerified,
    errors,
  }
  status(
    `  submitted=${result.submittedFps.toFixed(1)}fps encoded=${result.encodedFps.toFixed(1)}fps ` +
      `pendingMax=${result.pendingAddsMax} addP95=${result.addP95Ms.toFixed(1)}ms ` +
      `tickLagP95=${result.tickLagP95Ms.toFixed(1)}ms finalize=${result.finalizeMs.toFixed(0)}ms ` +
      `webm=${(result.webmBytes / 1024).toFixed(0)}KB roundTrip=${result.roundTripDemuxed}/${result.framesEncoded} ok=${result.roundTripVerified}`,
  )
  return result
}

async function run(): Promise<void> {
  status(
    `synthetic-30fps-stress: ${params.passes.length} resolutions × ${params.captureSeconds}s @ ${params.targetFps}fps`,
  )
  const reports: PassResult[] = []
  for (const pass of params.passes) {
    try {
      reports.push(await runPass(pass))
    } catch (error) {
      status(`  FAILED: ${error instanceof Error ? error.message : String(error)}`)
      reports.push({
        label: pass.label,
        width: pass.width,
        height: pass.height,
        targetFps: params.targetFps,
        framesSubmitted: 0,
        framesEncoded: 0,
        submittedFps: 0,
        encodedFps: 0,
        pendingAddsMax: 0,
        addP95Ms: 0,
        addMaxMs: 0,
        tickLagMaxMs: 0,
        tickLagP95Ms: 0,
        finalizeMs: 0,
        webmBytes: 0,
        webmBytesPerSecond: 0,
        roundTripDemuxed: 0,
        roundTripVerified: false,
        errors: [error instanceof Error ? error.message : String(error)],
      })
    }
    await wait(500)
  }
  status("done.")
  reportResult("synthetic-30fps-stress", params, { passes: reports })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("synthetic-30fps-stress", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
