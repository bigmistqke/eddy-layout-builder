// capture-encode-decoders-in-workers — same shape as 30b but with
// each playback decoder living in its own web worker, matching the
// phase 2 production layout. Isolates whether moving decode off the
// main thread restores the encoder's 720p headroom.

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
  encodeResolution: { width: 1280, height: 720 },
  encodeSeconds: 10,
  targetFps: 30,
  bitratePerPixel: 0.1,
  codec: "av1" as const,
  fixtureSeconds: 6,
  warmupMs: 1000,
  concurrencies: [4, 9],
}

interface WorkerHandle {
  worker: Worker
  framesDecodedAtSnapshot: number
  poll(): Promise<number>
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

interface ChunkInit {
  type: "key" | "delta"
  timestamp: number
  duration: number | null
  data: ArrayBuffer
}

async function buildFixture(): Promise<{
  chunkInits: ChunkInit[]
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
  const chunkInits: ChunkInit[] = []
  for await (const packet of sink.packets()) {
    const chunk = packet.toEncodedVideoChunk()
    const data = new ArrayBuffer(chunk.byteLength)
    chunk.copyTo(data)
    chunkInits.push({
      type: chunk.type,
      timestamp: chunk.timestamp,
      duration: chunk.duration,
      data,
    })
  }
  if (chunkInits.length === 0 || chunkInits[0].type !== "key") {
    throw new Error("buildFixture: missing leading key chunk")
  }
  status(`  fixture: ${chunkInits.length} chunks, ${(blob.size / 1024).toFixed(0)} KB`)
  return { chunkInits, config }
}

async function spawnDecoderWorker(
  chunkInits: ChunkInit[],
  config: VideoDecoderConfig,
): Promise<WorkerHandle> {
  const worker = new Worker(new URL("./decoder-worker.ts", import.meta.url), {
    type: "module",
  })
  const { promise: ready, resolve: resolveReady } = Promise.withResolvers<void>()
  worker.onmessage = (event: MessageEvent<{ type: string }>) => {
    if (event.data.type === "ready") {
      resolveReady()
    }
  }
  // Each worker gets its own clone of the chunk data — structured
  // clone is needed because EncodedVideoChunk isn't transferable as-is.
  const clonedChunks: ChunkInit[] = chunkInits.map(c => ({
    type: c.type,
    timestamp: c.timestamp,
    duration: c.duration,
    data: c.data.slice(0),
  }))
  worker.postMessage({
    type: "init",
    chunks: clonedChunks,
    config,
    copyWidth: params.encodeResolution.width,
    copyHeight: params.encodeResolution.height,
    targetFps: params.targetFps,
  })
  await ready

  const handle: WorkerHandle = {
    worker,
    framesDecodedAtSnapshot: 0,
    async poll(): Promise<number> {
      const { promise, resolve } = Promise.withResolvers<number>()
      const onMessage = (event: MessageEvent<{ type: string; framesDecoded?: number }>): void => {
        if (event.data.type === "poll-response") {
          worker.removeEventListener("message", onMessage)
          resolve(event.data.framesDecoded ?? 0)
        }
      }
      worker.addEventListener("message", onMessage)
      worker.postMessage({ type: "poll" })
      return promise
    },
    stop(): void {
      worker.postMessage({ type: "stop" })
      // Give the loop a moment to exit cleanly, then terminate.
      setTimeout(() => {
        worker.terminate()
      }, 50)
    },
  }
  return handle
}

async function runForK(
  K: number,
  fixture: { chunkInits: ChunkInit[]; config: VideoDecoderConfig },
): Promise<RunResult> {
  const errors: string[] = []
  status(`PASS K=${K}`)

  const workers: WorkerHandle[] = []
  for (let i = 0; i < K; i++) {
    workers.push(await spawnDecoderWorker(fixture.chunkInits, fixture.config))
  }
  await wait(params.warmupMs)
  status(`  warmup done, encoding ${params.encodeSeconds}s…`)

  const baselines = await Promise.all(workers.map(w => w.poll()))

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

  const finals = await Promise.all(workers.map(w => w.poll()))
  for (const w of workers) {
    w.stop()
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

  const decoderFps = finals.map((f, i) => (f - baselines[i]) / params.encodeSeconds)
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
      `tickLagP95=${result.tickLagP95Ms.toFixed(1)}ms finalize=${result.finalizeMs.toFixed(0)}ms ` +
      `roundTrip=${result.roundTripDemuxed}/${result.framesEncoded}`,
  )
  return result
}

async function run(): Promise<void> {
  status(
    `capture-encode-decoders-in-workers: K ∈ {${params.concurrencies.join(",")}}, encode ${params.encodeResolution.width}×${params.encodeResolution.height} × ${params.encodeSeconds}s @ ${params.targetFps}fps`,
  )
  const fixture = await buildFixture()
  const runs: RunResult[] = []
  for (const K of params.concurrencies) {
    try {
      runs.push(await runForK(K, fixture))
    } catch (error) {
      status(`  FAILED K=${K}: ${error instanceof Error ? error.message : String(error)}`)
    }
    await wait(1000)
  }
  status("done.")
  reportResult("capture-encode-decoders-in-workers", params, { runs })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("capture-encode-decoders-in-workers", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
