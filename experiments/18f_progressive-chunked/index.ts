// progressive-chunked — 9-stage progressive recording where atlas
// rebuilds are CHUNKED (per 18e) instead of mono. Each stage's
// build runs as 3 sequential chunks with setTimeout(0) yields
// between, so render stays at baseline jank even as the atlas
// grows with N cells.
//
// Render is intentionally minimal — just the live camera in the
// current cell; previous cells stay black. The point of this test
// is to validate chunked atlas builds at growing N (1..9), not the
// full multi-cell render pipeline.

import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from "mediabunny"
import { wait } from "../../src/utils"
import type { ProbeInput } from "../harness/input"
import { JankRecorder, observeLongTasks, type JankReport, type LongTaskReport } from "../harness/jank"
import { reportResult, status } from "../harness/report"
import type { ChunkAtlas } from "../18e_idle-build/composite-chunk"

const params = {
  captureResolution: { width: 1280, height: 720 },
  canvasResolution: { width: 540, height: 982 },
  takeSeconds: 6,
  stages: 9,
  chunkCount: 3,
  /** Atlas: 1 column × N rows (vertical stack matches viewport split). */
  atlasResolutionWidth: 540,
}

interface PrepareRequest {
  type: "prepare"
  sources: ProbeInput[]
  cols: number
  rows: number
  atlasWidth: number
  atlasHeight: number
}
interface BuildChunkRequest {
  type: "build-chunk"
  frameStart: number
  frameEnd: number
}
interface DisposeRequest {
  type: "dispose"
}
interface PreparedMessage {
  type: "prepared"
  totalFrames: number
}
interface ChunkBuiltMessage {
  type: "chunk-built"
  chunk: ChunkAtlas
}
interface DisposedMessage {
  type: "disposed"
}
type WorkerResponse = PreparedMessage | ChunkBuiltMessage | DisposedMessage

class ChunkWorker {
  private readonly worker: Worker
  private pending: ((message: WorkerResponse) => void) | null = null
  constructor() {
    // Reuses 18e's chunk-worker.ts unchanged.
    this.worker = new Worker(new URL("../18e_idle-build/chunk-worker.ts", import.meta.url), {
      type: "module",
    })
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const cb = this.pending
      this.pending = null
      cb?.(event.data)
    }
  }
  private send<T extends WorkerResponse>(
    req: PrepareRequest | BuildChunkRequest | DisposeRequest,
  ): Promise<T> {
    if (this.pending !== null) {
      throw new Error("ChunkWorker: in-flight request already")
    }
    return new Promise<T>(resolve => {
      this.pending = msg => resolve(msg as T)
      this.worker.postMessage(req)
    })
  }
  prepare(sources: ProbeInput[], cols: number, rows: number, atlasWidth: number, atlasHeight: number) {
    return this.send<PreparedMessage>({
      type: "prepare",
      sources,
      cols,
      rows,
      atlasWidth,
      atlasHeight,
    })
  }
  buildChunk(frameStart: number, frameEnd: number) {
    return this.send<ChunkBuiltMessage>({ type: "build-chunk", frameStart, frameEnd })
  }
  async dispose() {
    await this.send<DisposedMessage>({ type: "dispose" })
    this.worker.terminate()
  }
}

async function recordClip(stream: MediaStream, seconds: number): Promise<{
  clip: ProbeInput
  frameTimestamps: number[]
}> {
  const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8,opus" })
  const blobParts: Blob[] = []
  recorder.ondataavailable = event => {
    if (event.data.size > 0) {
      blobParts.push(event.data)
    }
  }
  const { promise: stopped, resolve: onStopped } = Promise.withResolvers<void>()
  recorder.onstop = () => {
    onStopped()
  }
  recorder.start()
  await wait(seconds * 1000)
  recorder.stop()
  await stopped
  const blob = new Blob(blobParts, { type: "video/webm;codecs=vp8,opus" })
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  const recordedTrack = await input.getPrimaryVideoTrack()
  if (recordedTrack === null) {
    throw new Error("recordClip: no video track")
  }
  const config = await recordedTrack.getDecoderConfig()
  if (config === null) {
    throw new Error("recordClip: no decoder config")
  }
  const sink = new EncodedPacketSink(recordedTrack)
  const chunks: EncodedVideoChunk[] = []
  const frameTimestamps: number[] = []
  for await (const packet of sink.packets()) {
    const chunk = packet.toEncodedVideoChunk()
    if (chunks.length === 0 && chunk.type !== "key") {
      continue
    }
    chunks.push(chunk)
    frameTimestamps.push(chunk.timestamp)
  }
  if (chunks.length === 0) {
    throw new Error("recordClip: no keyframe")
  }
  return {
    clip: {
      config,
      chunks,
      width: recordedTrack.codedWidth,
      height: recordedTrack.codedHeight,
      requestedWidth: params.captureResolution.width,
      requestedHeight: params.captureResolution.height,
    },
    frameTimestamps,
  }
}

interface IntegrityReport {
  framesActual: number
  framesDropped: number
  measuredFps: number
}

function checkIntegrity(timestamps: number[]): IntegrityReport {
  if (timestamps.length < 2) {
    return { framesActual: timestamps.length, framesDropped: 0, measuredFps: 0 }
  }
  const intervals: number[] = []
  for (let i = 1; i < timestamps.length; i++) {
    intervals.push((timestamps[i] - timestamps[i - 1]) / 1000)
  }
  const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length
  const drops = intervals.filter(i => i > mean * 1.5).reduce((acc, i) => acc + Math.round(i / mean) - 1, 0)
  return { framesActual: timestamps.length, framesDropped: drops, measuredFps: 1000 / mean }
}

interface StageStats {
  stage: number
  cellCount: number
  recordRenderFps: number
  buildRenderFps: number
  recordJank: JankReport
  buildJank: JankReport
  buildChunks: Array<{ buildMs: number; frameStart: number; frameEnd: number; atlasBytes: number }>
  buildTotalMs: number
  stageWallClockSeconds: number
  integrity: IntegrityReport
}

function readHeapMb(): number {
  const perf = performance as unknown as { memory?: { usedJSHeapSize: number } }
  return perf.memory ? perf.memory.usedJSHeapSize / 1_000_000 : 0
}

async function run(): Promise<void> {
  status(`progressive-chunked: ${params.stages} stages × ${params.takeSeconds}s takes, ${params.chunkCount} chunks per build`)
  status(`initial heap: ${readHeapMb().toFixed(1)} MB`)

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: params.captureResolution.width, height: params.captureResolution.height },
    audio: true,
  })
  const liveVideo = document.createElement("video")
  liveVideo.muted = true
  liveVideo.playsInline = true
  liveVideo.autoplay = true
  liveVideo.srcObject = new MediaStream(stream.getVideoTracks())
  await new Promise<void>(resolve => {
    liveVideo.onloadedmetadata = () => resolve()
  })
  await liveVideo.play()

  const canvas = document.createElement("canvas")
  canvas.width = params.canvasResolution.width
  canvas.height = params.canvasResolution.height
  canvas.style.cssText = "display:block;width:200px;height:auto;border:1px solid #444"
  document.body.appendChild(canvas)
  const glOrNull = canvas.getContext("webgl2")
  if (glOrNull === null) {
    throw new Error("no webgl2")
  }
  const gl: WebGL2RenderingContext = glOrNull
  const vs = gl.createShader(gl.VERTEX_SHADER)!
  gl.shaderSource(
    vs,
    `#version 300 es
in vec2 aQuad;
uniform vec2 uNdcOffset;
uniform vec2 uNdcScale;
out vec2 vUv;
void main() {
  vec2 corner = (aQuad + 1.0) * 0.5;
  vUv = corner;
  gl_Position = vec4(uNdcOffset + corner * uNdcScale, 0.0, 1.0);
}`,
  )
  gl.compileShader(vs)
  const fs = gl.createShader(gl.FRAGMENT_SHADER)!
  gl.shaderSource(
    fs,
    `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTex;
out vec4 outColor;
void main() { outColor = texture(uTex, vUv); }`,
  )
  gl.compileShader(fs)
  const program = gl.createProgram()!
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  gl.useProgram(program)
  const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1])
  const vbo = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW)
  const aQuad = gl.getAttribLocation(program, "aQuad")
  gl.enableVertexAttribArray(aQuad)
  gl.vertexAttribPointer(aQuad, 2, gl.FLOAT, false, 0, 0)
  const uNdcOffset = gl.getUniformLocation(program, "uNdcOffset")
  const uNdcScale = gl.getUniformLocation(program, "uNdcScale")
  const liveTex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, liveTex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  let stop = false
  let liveCellIndex = -1
  let cellCount = 0
  const stageJankRecorder = new JankRecorder()
  const longtaskObserver = observeLongTasks()
  let peakHeapMb = readHeapMb()
  let tickCount = 0

  function tick() {
    if (stop) {
      return
    }
    stageJankRecorder.mark()
    tickCount++
    if (tickCount % 30 === 0) {
      const h = readHeapMb()
      if (h > peakHeapMb) {
        peakHeapMb = h
      }
    }
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    if (liveCellIndex >= 0 && liveVideo.readyState >= 2 && cellCount > 0) {
      const sliceH = 2 / cellCount
      const ndcY = 1 - (liveCellIndex + 1) * sliceH
      gl.bindTexture(gl.TEXTURE_2D, liveTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, liveVideo)
      gl.uniform2f(uNdcOffset, -1, ndcY)
      gl.uniform2f(uNdcScale, 2, sliceH)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  const clips: ProbeInput[] = []
  const stats: StageStats[] = []
  const startWall = performance.now()

  for (let stage = 1; stage <= params.stages; stage++) {
    const stageStart = performance.now()
    cellCount = stage
    liveCellIndex = stage - 1
    status(`STAGE ${stage}/${params.stages}: ${stage} cells, recording into cell ${stage - 1}...`)

    // RECORD
    stageJankRecorder.reset()
    const recordStart = performance.now()
    const { clip, frameTimestamps } = await recordClip(stream, params.takeSeconds)
    const recordEnd = performance.now()
    const recordJank = stageJankRecorder.snapshot()
    const recordRenderFps = recordJank.framesObserved / ((recordEnd - recordStart) / 1000)
    clips.push(clip)
    const integrity = checkIntegrity(frameTimestamps)
    liveCellIndex = -1

    // BUILD: chunked atlas of all N clips so far. Atlas: 1 col × N rows.
    stageJankRecorder.reset()
    const buildStart = performance.now()
    const composer = new ChunkWorker()
    const rows = clips.length
    const atlasHeight = Math.floor(params.canvasResolution.height / rows) * rows
    const prepared = await composer.prepare(clips, 1, rows, params.atlasResolutionWidth, atlasHeight)
    const totalFrames = prepared.totalFrames
    const chunkSize = Math.ceil(totalFrames / params.chunkCount)
    const buildChunks: StageStats["buildChunks"] = []
    for (let chunk = 0; chunk < params.chunkCount; chunk++) {
      const frameStart = chunk * chunkSize
      const frameEnd = Math.min(totalFrames, frameStart + chunkSize)
      if (frameStart >= frameEnd) {
        break
      }
      const response = await composer.buildChunk(frameStart, frameEnd)
      buildChunks.push({
        buildMs: response.chunk.compositeMs,
        frameStart: response.chunk.frameStart,
        frameEnd: response.chunk.frameEnd,
        atlasBytes: response.chunk.atlasBytes,
      })
      if (chunk < params.chunkCount - 1) {
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      }
    }
    await composer.dispose()
    const buildEnd = performance.now()
    const buildJank = stageJankRecorder.snapshot()
    const buildRenderFps = buildJank.framesObserved / ((buildEnd - buildStart) / 1000)
    const buildTotalMs = buildEnd - buildStart

    const stageEnd = performance.now()
    const heap = readHeapMb()
    if (heap > peakHeapMb) {
      peakHeapMb = heap
    }
    stats.push({
      stage,
      cellCount: stage,
      recordRenderFps,
      buildRenderFps,
      recordJank,
      buildJank,
      buildChunks,
      buildTotalMs,
      stageWallClockSeconds: (stageEnd - stageStart) / 1000,
      integrity,
    })
    status(
      `  rec: fps=${recordRenderFps.toFixed(1)} score=${recordJank.jankScore.toFixed(1)} streak=${recordJank.longestJankStreak}; ` +
        `build: ${buildChunks.map(c => c.buildMs.toFixed(0)).join("+")} = ${buildTotalMs.toFixed(0)}ms, fps=${buildRenderFps.toFixed(1)} score=${buildJank.jankScore.toFixed(1)} streak=${buildJank.longestJankStreak}; ` +
        `cam ${integrity.framesActual}f/${integrity.framesDropped}drop@${integrity.measuredFps.toFixed(1)}; heap=${heap.toFixed(1)}MB`,
    )
  }

  stop = true
  for (const track of stream.getTracks()) {
    track.stop()
  }
  liveVideo.srcObject = null
  document.body.removeChild(canvas)

  const sessionSeconds = (performance.now() - startWall) / 1000
  const longtaskReport = longtaskObserver.stop()
  status(
    `SESSION COMPLETE: ${sessionSeconds.toFixed(1)}s, peakHeap=${peakHeapMb.toFixed(1)}MB, longtasks=${longtaskReport.observed}`,
  )
  status("done.")
  reportResult("progressive-chunked", params, {
    stages: stats,
    sessionSeconds,
    peakHeapMb,
    longtasks: longtaskReport satisfies LongTaskReport,
  })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("progressive-chunked", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
