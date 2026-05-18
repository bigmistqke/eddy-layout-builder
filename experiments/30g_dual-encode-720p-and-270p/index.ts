// dual-encode-720p-and-270p — two simultaneous AV1 encoders fed from
// the same synthetic 720p source. Encoder A keeps native 720p (for
// export/fullscreen); encoder B writes a 270p mip (for cell playback)
// via WebGL2 canvas-wrap resize (the winner from exp 31). K=4/9 270p
// decoders in workers simulate the playback workload concurrently.

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
  highResolution: { width: 1280, height: 720 },
  lowResolution: { width: 480, height: 272 },
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
  poll(): Promise<number>
  stop(): void
}

interface EncoderStats {
  framesSubmitted: number
  framesEncoded: number
  encodedFps: number
  pendingAddsMax: number
  addP95Ms: number
  addMaxMs: number
  finalizeMs: number
  webmBytes: number
  roundTripDemuxed: number
  roundTripVerified: boolean
}

interface RunResult {
  K: number
  encoderHigh: EncoderStats
  encoderLow: EncoderStats
  resizeP95Ms: number
  resizeMaxMs: number
  tickLagP95Ms: number
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

// Build a 270p AV1 fixture for the workers to loop (decoders read the
// low-res mip in production).
async function buildFixture(): Promise<{
  chunkInits: ChunkInit[]
  config: VideoDecoderConfig
}> {
  status(
    `fixture: encoding ${params.fixtureSeconds}s ${params.lowResolution.width}×${params.lowResolution.height} @ ${params.targetFps}fps…`,
  )
  const canvas = new OffscreenCanvas(
    params.lowResolution.width,
    params.lowResolution.height,
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
    params.lowResolution.width *
      params.lowResolution.height *
      params.targetFps *
      params.bitratePerPixel,
  )
  const videoSource = new VideoSampleSource({ codec: params.codec, bitrate })
  output.addVideoTrack(videoSource)
  await output.start()

  const totalFrames = params.fixtureSeconds * params.targetFps
  for (let i = 0; i < totalFrames; i++) {
    paintFrame(context, params.lowResolution.width, params.lowResolution.height, i)
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
    throw new Error("buildFixture: no track")
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
    copyWidth: params.lowResolution.width,
    copyHeight: params.lowResolution.height,
    targetFps: params.targetFps,
  })
  await ready

  return {
    worker,
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
      setTimeout(() => {
        worker.terminate()
      }, 50)
    },
  }
}

interface EncoderRig {
  output: Output
  source: VideoSampleSource
  stats: {
    framesSubmitted: number
    framesEncoded: number
    pendingAdds: number
    pendingAddsMax: number
    addTimings: number[]
    errors: string[]
  }
}

async function makeEncoderRig(width: number, height: number): Promise<EncoderRig> {
  const output = new Output({
    format: new WebMOutputFormat(),
    target: new BufferTarget(),
  })
  const bitrate = Math.round(
    width * height * params.targetFps * params.bitratePerPixel,
  )
  const source = new VideoSampleSource({ codec: params.codec, bitrate })
  output.addVideoTrack(source)
  await output.start()
  return {
    output,
    source,
    stats: {
      framesSubmitted: 0,
      framesEncoded: 0,
      pendingAdds: 0,
      pendingAddsMax: 0,
      addTimings: [],
      errors: [],
    },
  }
}

function submitToEncoder(rig: EncoderRig, sample: VideoSample): void {
  rig.stats.framesSubmitted++
  rig.stats.pendingAdds++
  if (rig.stats.pendingAdds > rig.stats.pendingAddsMax) {
    rig.stats.pendingAddsMax = rig.stats.pendingAdds
  }
  const addStart = performance.now()
  rig.source
    .add(sample)
    .then(() => {
      rig.stats.addTimings.push(performance.now() - addStart)
      rig.stats.framesEncoded++
    })
    .catch((error: unknown) => {
      rig.stats.errors.push(error instanceof Error ? error.message : String(error))
    })
    .finally(() => {
      rig.stats.pendingAdds--
      sample.close()
    })
}

interface ResizeRig {
  canvas: OffscreenCanvas
  gl: WebGL2RenderingContext
  texture: WebGLTexture
}

// WebGL2 canvas-wrap resize — the winner from exp 31 (0.8ms p50 sync).
// Upload the source frame as TEXTURE_2D, draw a full-canvas quad on a
// target-res GL canvas, gl.finish(), wrap canvas as VideoFrame.
function setupResizeRig(width: number, height: number): ResizeRig {
  const canvas = new OffscreenCanvas(width, height)
  const glOrNull = canvas.getContext("webgl2", { antialias: false, premultipliedAlpha: true })
  if (glOrNull === null) {
    throw new Error("setupResizeRig: WebGL2 unavailable")
  }
  const gl: WebGL2RenderingContext = glOrNull
  const vsSource = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2((a_pos.x + 1.0) * 0.5, (1.0 - a_pos.y) * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`
  const fsSource = `#version 300 es
precision mediump float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 outColor;
void main() {
  outColor = texture(u_tex, v_uv);
}
`
  function compile(type: number, source: string): WebGLShader {
    const shader = gl.createShader(type)
    if (shader === null) {
      throw new Error("compile: createShader")
    }
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`compile: ${gl.getShaderInfoLog(shader) ?? ""}`)
    }
    return shader
  }
  const vs = compile(gl.VERTEX_SHADER, vsSource)
  const fs = compile(gl.FRAGMENT_SHADER, fsSource)
  const program = gl.createProgram()
  if (program === null) {
    throw new Error("setupResizeRig: createProgram")
  }
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`setupResizeRig: link ${gl.getProgramInfoLog(program) ?? ""}`)
  }
  gl.useProgram(program)
  const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1])
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW)
  const aPos = gl.getAttribLocation(program, "a_pos")
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)
  const texture = gl.createTexture()
  if (texture === null) {
    throw new Error("setupResizeRig: createTexture")
  }
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.viewport(0, 0, width, height)
  return { canvas, gl, texture }
}

// Uses transferToImageBitmap to detach an independent bitmap per
// call — avoids the canvas-aliasing problem when the encoder reads
// the VideoFrame asynchronously (multiple in-flight frames must not
// share the same evolving canvas).
function resizeWithWebgl(rig: ResizeRig, source: VideoFrame, timestampUs: number): VideoFrame {
  rig.gl.bindTexture(rig.gl.TEXTURE_2D, rig.texture)
  rig.gl.texImage2D(
    rig.gl.TEXTURE_2D,
    0,
    rig.gl.RGBA,
    rig.gl.RGBA,
    rig.gl.UNSIGNED_BYTE,
    source,
  )
  rig.gl.drawArrays(rig.gl.TRIANGLE_STRIP, 0, 4)
  rig.gl.finish()
  const bitmap = rig.canvas.transferToImageBitmap()
  const out = new VideoFrame(bitmap, { timestamp: timestampUs })
  bitmap.close()
  return out
}

async function finalizeEncoder(rig: EncoderRig): Promise<EncoderStats> {
  const drainStart = performance.now()
  while (rig.stats.pendingAdds > 0) {
    await wait(10)
    if (performance.now() - drainStart > 60_000) {
      rig.stats.errors.push(`drain: still ${rig.stats.pendingAdds} pending`)
      break
    }
  }
  const finalizeStart = performance.now()
  rig.source.close()
  await rig.output.finalize()
  const finalizeMs = performance.now() - finalizeStart

  const buffer = (rig.output.target as BufferTarget).buffer
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
        roundTripVerified = roundTripDemuxed === rig.stats.framesEncoded
      }
    } catch (error) {
      rig.stats.errors.push(
        `roundtrip: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const sortedAdd = rig.stats.addTimings.slice().sort((a, b) => a - b)
  const p95Idx = Math.min(sortedAdd.length - 1, Math.floor(sortedAdd.length * 0.95))
  return {
    framesSubmitted: rig.stats.framesSubmitted,
    framesEncoded: rig.stats.framesEncoded,
    encodedFps: rig.stats.framesEncoded / params.encodeSeconds,
    pendingAddsMax: rig.stats.pendingAddsMax,
    addP95Ms: sortedAdd.length > 0 ? sortedAdd[p95Idx] : 0,
    addMaxMs: sortedAdd.length > 0 ? sortedAdd[sortedAdd.length - 1] : 0,
    finalizeMs,
    webmBytes,
    roundTripDemuxed,
    roundTripVerified,
  }
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
  status(`  warmup done, dual-encoding ${params.encodeSeconds}s…`)
  const decoderBaselines = await Promise.all(workers.map(w => w.poll()))

  const highCanvas = new OffscreenCanvas(
    params.highResolution.width,
    params.highResolution.height,
  )
  const highContext = highCanvas.getContext("2d")
  if (highContext === null) {
    throw new Error("runForK: no 2d context")
  }
  const encoderHigh = await makeEncoderRig(
    params.highResolution.width,
    params.highResolution.height,
  )
  const encoderLow = await makeEncoderRig(
    params.lowResolution.width,
    params.lowResolution.height,
  )
  const resizeRig = setupResizeRig(
    params.lowResolution.width,
    params.lowResolution.height,
  )

  const tickIntervalMs = 1000 / params.targetFps
  const totalFrames = params.encodeSeconds * params.targetFps
  const encodeStartMs = performance.now()
  const tickLags: number[] = []
  const resizeTimings: number[] = []

  for (let i = 0; i < totalFrames; i++) {
    const scheduledMs = encodeStartMs + i * tickIntervalMs
    const waitMs = scheduledMs - performance.now()
    if (waitMs > 0) {
      await wait(waitMs)
    }
    tickLags.push(performance.now() - scheduledMs)

    paintFrame(
      highContext,
      params.highResolution.width,
      params.highResolution.height,
      i,
    )
    const timestampUs = Math.round((i / params.targetFps) * 1_000_000)
    const highFrame = new VideoFrame(highCanvas, { timestamp: timestampUs })

    // Branch A: feed 720p frame directly to the high encoder.
    const highSample = new VideoSample(highFrame.clone())
    submitToEncoder(encoderHigh, highSample)

    // Branch B: WebGL2 canvas-wrap resize → wrap as VideoFrame → feed
    // to the low encoder. Per exp 31, this is the fastest production-
    // viable resize on this device (~0.8ms p50 sync).
    const resizeStart = performance.now()
    try {
      const lowFrame = resizeWithWebgl(resizeRig, highFrame, timestampUs)
      resizeTimings.push(performance.now() - resizeStart)
      const lowSample = new VideoSample(lowFrame)
      submitToEncoder(encoderLow, lowSample)
    } catch (error) {
      errors.push(`resize: ${error instanceof Error ? error.message : String(error)}`)
    }

    highFrame.close()
  }

  const decoderFinals = await Promise.all(workers.map(w => w.poll()))
  for (const w of workers) {
    w.stop()
  }

  // Finalize both encoders in parallel so we get a fair finalize time
  // for each (matches the production pattern: record-stop fires both).
  const [statsHigh, statsLow] = await Promise.all([
    finalizeEncoder(encoderHigh),
    finalizeEncoder(encoderLow),
  ])

  const decoderFps = decoderFinals.map(
    (f, i) => (f - decoderBaselines[i]) / params.encodeSeconds,
  )
  const decoderFpsMin = decoderFps.length === 0 ? 0 : Math.min(...decoderFps)
  const decoderFpsMean =
    decoderFps.length === 0 ? 0 : decoderFps.reduce((a, b) => a + b, 0) / decoderFps.length
  const totalDecoderFps = decoderFps.reduce((a, b) => a + b, 0)

  const sortedResize = resizeTimings.slice().sort((a, b) => a - b)
  const p95RIdx = Math.min(sortedResize.length - 1, Math.floor(sortedResize.length * 0.95))
  const sortedLag = tickLags.slice().sort((a, b) => a - b)
  const p95LIdx = Math.min(sortedLag.length - 1, Math.floor(sortedLag.length * 0.95))

  const result: RunResult = {
    K,
    encoderHigh: statsHigh,
    encoderLow: statsLow,
    resizeP95Ms: sortedResize.length > 0 ? sortedResize[p95RIdx] : 0,
    resizeMaxMs: sortedResize.length > 0 ? sortedResize[sortedResize.length - 1] : 0,
    tickLagP95Ms: sortedLag.length > 0 ? sortedLag[p95LIdx] : 0,
    decoderFps,
    decoderFpsMin,
    decoderFpsMean,
    totalDecoderFps,
    errors: [...errors, ...encoderHigh.stats.errors, ...encoderLow.stats.errors],
  }
  status(
    `  K=${K} high:${result.encoderHigh.encodedFps.toFixed(1)}fps/pend${result.encoderHigh.pendingAddsMax}/p95${result.encoderHigh.addP95Ms.toFixed(0)}ms ` +
      `low:${result.encoderLow.encodedFps.toFixed(1)}fps/pend${result.encoderLow.pendingAddsMax}/p95${result.encoderLow.addP95Ms.toFixed(0)}ms ` +
      `resize p95=${result.resizeP95Ms.toFixed(1)}ms tickLag p95=${result.tickLagP95Ms.toFixed(1)}ms ` +
      `decMin=${result.decoderFpsMin.toFixed(1)}fps ` +
      `finalize hi=${result.encoderHigh.finalizeMs.toFixed(0)}ms lo=${result.encoderLow.finalizeMs.toFixed(0)}ms`,
  )
  return result
}

async function run(): Promise<void> {
  status(
    `dual-encode-720p-and-270p: K ∈ {${params.concurrencies.join(",")}}, ${params.encodeSeconds}s @ ${params.targetFps}fps`,
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
  reportResult("dual-encode-720p-and-270p", params, { runs })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("dual-encode-720p-and-270p", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
