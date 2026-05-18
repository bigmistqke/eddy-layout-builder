// capture-encode-under-playback — runs the 30d synthetic AV1 encode
// while K decoders are concurrently decoding + copying RGBA in a loop,
// to measure encoder behavior under realistic playback contention.

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
  encodeResolution: { width: 480, height: 272 },
  encodeSeconds: 10,
  targetFps: 30,
  bitratePerPixel: 0.1,
  codec: "av1" as const,
  fixtureSeconds: 6,
  warmupMs: 1000,
  concurrencies: [4, 9],
}

interface DecoderHandle {
  decoder: VideoDecoder
  framesDecoded: number
  stop(): void
}

interface RunResult {
  K: number
  encodeWidth: number
  encodeHeight: number
  targetFps: number
  framesSubmitted: number
  framesEncoded: number
  submittedFps: number
  encodedFps: number
  pendingAddsMax: number
  addP95Ms: number
  addMaxMs: number
  tickLagP95Ms: number
  finalizeMs: number
  webmBytes: number
  roundTripDemuxed: number
  roundTripVerified: boolean
  decoderFps: number[]
  decoderFpsMin: number
  decoderFpsMean: number
  totalDecoderFps: number
  errors: string[]
}

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
  const boxX = (frameIndex * 7) % (width - boxSize)
  const boxY = (frameIndex * 11) % (height - boxSize)
  context.fillStyle = "#000"
  context.fillRect(boxX, boxY, boxSize, boxSize)
  context.fillStyle = "#fff"
  context.font = `${(boxSize / 2) | 0}px monospace`
  context.fillText(String(frameIndex), boxX + 4, boxY + boxSize / 2)
}

// Pre-encode a synthetic-pattern AV1 WebM, then demux back to chunks
// + decoder config so the decoders below can loop the fixture.
async function buildFixture(): Promise<{
  chunks: EncodedVideoChunk[]
  config: VideoDecoderConfig
}> {
  status(
    `fixture: encoding ${params.fixtureSeconds}s @ ${params.targetFps}fps ${params.encodeResolution.width}×${params.encodeResolution.height}…`,
  )
  const canvas = new OffscreenCanvas(
    params.encodeResolution.width,
    params.encodeResolution.height,
  )
  const context = canvas.getContext("2d")
  if (context === null) {
    throw new Error("buildFixture: no 2d context")
  }
  const output = new Output({
    format: new WebMOutputFormat(),
    target: new BufferTarget(),
  })
  const bitrate = Math.round(
    params.encodeResolution.width *
      params.encodeResolution.height *
      params.targetFps *
      params.bitratePerPixel,
  )
  const videoSource = new VideoSampleSource({ codec: params.codec, bitrate })
  output.addVideoTrack(videoSource)
  await output.start()

  const totalFrames = params.fixtureSeconds * params.targetFps
  for (let i = 0; i < totalFrames; i++) {
    paintFrame(context, params.encodeResolution.width, params.encodeResolution.height, i)
    const timestampUs = Math.round((i / params.targetFps) * 1_000_000)
    const frame = new VideoFrame(canvas, { timestamp: timestampUs })
    const sample = new VideoSample(frame)
    await videoSource.add(sample)
    sample.close()
    frame.close()
  }
  videoSource.close()
  await output.finalize()
  const buffer = (output.target as BufferTarget).buffer
  if (buffer === null) {
    throw new Error("buildFixture: no buffer")
  }
  const blob = new Blob([buffer], { type: "video/webm" })

  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) })
  const track = await input.getPrimaryVideoTrack()
  if (track === null) {
    throw new Error("buildFixture: no track on re-demux")
  }
  const config = await track.getDecoderConfig()
  if (config === null) {
    throw new Error("buildFixture: no decoder config")
  }
  const sink = new EncodedPacketSink(track)
  const chunks: EncodedVideoChunk[] = []
  for await (const packet of sink.packets()) {
    chunks.push(packet.toEncodedVideoChunk())
  }
  if (chunks.length === 0 || chunks[0].type !== "key") {
    throw new Error("buildFixture: missing leading key chunk")
  }
  status(`  fixture: ${chunks.length} chunks, ${(blob.size / 1024).toFixed(0)} KB`)
  return { chunks, config }
}

// Spawn one looping decoder. It feeds chunks at targetFps, drops the
// decoded frame after copying it to RGBA (the eddy bitmap-source
// workload), then resets and starts over on the chunk loop. Returns a
// handle that tracks framesDecoded so the caller can window it.
function spawnLoopingDecoder(
  chunks: EncodedVideoChunk[],
  config: VideoDecoderConfig,
  width: number,
  height: number,
): DecoderHandle {
  const rgbaBuffer = new Uint8Array(width * height * 4)
  let stopped = false
  const handle: DecoderHandle = {
    decoder: null as unknown as VideoDecoder,
    framesDecoded: 0,
    stop(): void {
      stopped = true
    },
  }
  const decoder = new VideoDecoder({
    output(frame: VideoFrame): void {
      handle.framesDecoded++
      // Match the bitmap-source workload: copy to RGBA into a buffer.
      frame
        .copyTo(rgbaBuffer, { format: "RGBA" })
        .catch(() => {})
        .finally(() => {
          frame.close()
        })
    },
    error(): void {
      // Swallow — restart loop on next iteration.
    },
  })
  decoder.configure(config)
  handle.decoder = decoder

  void (async () => {
    const tickIntervalMs = 1000 / params.targetFps
    while (!stopped) {
      const loopStart = performance.now()
      for (let i = 0; i < chunks.length && !stopped; i++) {
        const scheduled = loopStart + i * tickIntervalMs
        const waitMs = scheduled - performance.now()
        if (waitMs > 0) {
          await wait(waitMs)
        }
        try {
          decoder.decode(chunks[i])
        } catch {
          // ignore + restart
          break
        }
      }
      // After a loop, reset so the next iteration starts cleanly with
      // the keyframe.
      try {
        await decoder.flush()
      } catch {}
      try {
        decoder.reset()
        decoder.configure(config)
      } catch {}
    }
    try {
      decoder.close()
    } catch {}
  })()

  return handle
}

async function runForK(
  K: number,
  fixture: { chunks: EncodedVideoChunk[]; config: VideoDecoderConfig },
): Promise<RunResult> {
  const errors: string[] = []
  status(`PASS K=${K}`)

  const decoders: DecoderHandle[] = []
  for (let i = 0; i < K; i++) {
    decoders.push(
      spawnLoopingDecoder(
        fixture.chunks,
        fixture.config,
        params.encodeResolution.width,
        params.encodeResolution.height,
      ),
    )
  }
  await wait(params.warmupMs)
  status(`  warmup done, encoding ${params.encodeSeconds}s…`)

  const decoderBaseline = decoders.map(d => d.framesDecoded)

  // Encoder side (mirror of 30d).
  const canvas = new OffscreenCanvas(
    params.encodeResolution.width,
    params.encodeResolution.height,
  )
  const context = canvas.getContext("2d")
  if (context === null) {
    throw new Error("runForK: no 2d context")
  }
  const output = new Output({
    format: new WebMOutputFormat(),
    target: new BufferTarget(),
  })
  const bitrate = Math.round(
    params.encodeResolution.width *
      params.encodeResolution.height *
      params.targetFps *
      params.bitratePerPixel,
  )
  const videoSource = new VideoSampleSource({ codec: params.codec, bitrate })
  output.addVideoTrack(videoSource)
  await output.start()

  const tickIntervalMs = 1000 / params.targetFps
  const totalFrames = params.encodeSeconds * params.targetFps
  const encodeStartMs = performance.now()
  let pendingAdds = 0
  let pendingAddsMax = 0
  let framesSubmitted = 0
  let framesEncoded = 0
  const addTimings: number[] = []
  const tickLags: number[] = []

  for (let i = 0; i < totalFrames; i++) {
    const scheduledMs = encodeStartMs + i * tickIntervalMs
    const waitMs = scheduledMs - performance.now()
    if (waitMs > 0) {
      await wait(waitMs)
    }
    tickLags.push(performance.now() - scheduledMs)

    paintFrame(context, params.encodeResolution.width, params.encodeResolution.height, i)
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
  const drainStart = performance.now()
  while (pendingAdds > 0) {
    await wait(10)
    if (performance.now() - drainStart > 60_000) {
      errors.push(`drain: still ${pendingAdds} pending`)
      break
    }
  }

  // Snapshot decoder progress at the same moment we stop the encoder.
  const decoderFinal = decoders.map(d => d.framesDecoded)
  for (const d of decoders) {
    d.stop()
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

  const decoderFps = decoderFinal.map(
    (final, i) => (final - decoderBaseline[i]) / params.encodeSeconds,
  )
  const decoderFpsMin = decoderFps.length === 0 ? 0 : Math.min(...decoderFps)
  const decoderFpsMean =
    decoderFps.length === 0 ? 0 : decoderFps.reduce((a, b) => a + b, 0) / decoderFps.length
  const totalDecoderFps = decoderFps.reduce((a, b) => a + b, 0)

  const sortedAdd = addTimings.slice().sort((a, b) => a - b)
  const p95AddIdx = Math.min(sortedAdd.length - 1, Math.floor(sortedAdd.length * 0.95))
  const sortedLag = tickLags.slice().sort((a, b) => a - b)
  const p95LagIdx = Math.min(sortedLag.length - 1, Math.floor(sortedLag.length * 0.95))

  const result: RunResult = {
    K,
    encodeWidth: params.encodeResolution.width,
    encodeHeight: params.encodeResolution.height,
    targetFps: params.targetFps,
    framesSubmitted,
    framesEncoded,
    submittedFps: framesSubmitted / params.encodeSeconds,
    encodedFps: framesEncoded / params.encodeSeconds,
    pendingAddsMax,
    addP95Ms: sortedAdd.length > 0 ? sortedAdd[p95AddIdx] : 0,
    addMaxMs: sortedAdd.length > 0 ? sortedAdd[sortedAdd.length - 1] : 0,
    tickLagP95Ms: sortedLag.length > 0 ? sortedLag[p95LagIdx] : 0,
    finalizeMs,
    webmBytes,
    roundTripDemuxed,
    roundTripVerified,
    decoderFps,
    decoderFpsMin,
    decoderFpsMean,
    totalDecoderFps,
    errors,
  }
  status(
    `  K=${K} encoded=${result.encodedFps.toFixed(1)}fps pendingMax=${result.pendingAddsMax} ` +
      `addP95=${result.addP95Ms.toFixed(1)}ms addMax=${result.addMaxMs.toFixed(0)}ms ` +
      `decoderMin=${result.decoderFpsMin.toFixed(1)}fps decoderMean=${result.decoderFpsMean.toFixed(1)}fps ` +
      `finalize=${result.finalizeMs.toFixed(0)}ms roundTrip=${result.roundTripDemuxed}/${result.framesEncoded}`,
  )
  return result
}

async function run(): Promise<void> {
  status(
    `capture-encode-under-playback: K ∈ {${params.concurrencies.join(",")}}, encode ${params.encodeResolution.width}×${params.encodeResolution.height} × ${params.encodeSeconds}s @ ${params.targetFps}fps`,
  )
  const fixture = await buildFixture()
  const runs: RunResult[] = []
  for (const K of params.concurrencies) {
    try {
      runs.push(await runForK(K, fixture))
    } catch (error) {
      status(`  FAILED K=${K}: ${error instanceof Error ? error.message : String(error)}`)
    }
    // Cool-down so consecutive K runs don't pollute each other.
    await wait(1000)
  }
  status("done.")
  reportResult("capture-encode-under-playback", params, { runs })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("capture-encode-under-playback", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
