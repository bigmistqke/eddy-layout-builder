// progressive-overlap-chunked — full hot-path with:
// * OPFS lo-fi bitmap streaming for previous cells (per 18c)
// * Long-lived cached chunk-worker (per-stage decodes only the NEW
//   clip; reuses cached bitmaps across all subsequent builds)
// * Chunked atlas build in background, concurrent with capture
// * Overlap: next stage starts immediately, no wait
// * Atlas not decoded back into cells (v1) — cells render from OPFS

import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from "mediabunny"
import { wait } from "../../src/utils"
import type { ProbeInput } from "../harness/input"
import { JankRecorder, observeLongTasks, type JankReport, type LongTaskReport } from "../harness/jank"
import { reportResult, status } from "../harness/report"

const params = {
  captureResolution: { width: 1280, height: 720 },
  canvasResolution: { width: 540, height: 982 },
  takeSeconds: 6,
  stages: 9,
  bitmapResolution: { width: 128, height: 232 },
  chunkCount: 3,
  atlasResolutionWidth: 540,
  // Cell size for the atlas (sources are decoded into bitmaps at
  // this size). Determined by atlas geometry / row count, but for
  // the long-lived worker we pick a single fixed size — cells in
  // the eventual atlas are this size each.
  atlasCellWidth: 540,
  atlasCellHeight: 100, // a single horizontal strip; ≈ canvasH / max stages
}

// ---- OPFS writer / reader response types (reused from 18c) ----
interface WriterDoneMessage {
  type: "done"
  framesWritten: number
  totalBytes: number
  writeTotalMs: number
}
interface ReaderFrameMessage {
  type: "frame"
  cellId: number
  frameIndex: number
  width: number
  height: number
  bytes: ArrayBuffer
}

// ---- Cached chunk-worker (local to 18g) ----
interface InitRequest {
  type: "init"
  cellWidth: number
  cellHeight: number
  atlasWidth: number
  atlasHeight: number
}
interface AddSourceRequest {
  type: "add-source"
  cellId: number
  source: ProbeInput
}
interface BuildChunkRequest {
  type: "build-chunk"
  cellOrder: number[]
  frameStart: number
  frameEnd: number
  cols: number
  rows: number
}
interface DisposeRequest {
  type: "dispose"
}
type WorkerRequest = InitRequest | AddSourceRequest | BuildChunkRequest | DisposeRequest

interface InitedMessage {
  type: "inited"
}
interface SourceAddedMessage {
  type: "source-added"
  cellId: number
  frameCount: number
  decodeMs: number
}
interface ChunkBuiltMessage {
  type: "chunk-built"
  frameStart: number
  frameEnd: number
  compositeMs: number
  atlasBytes: number
  atlas: ProbeInput
}
interface DisposedMessage {
  type: "disposed"
}
type WorkerResponse = InitedMessage | SourceAddedMessage | ChunkBuiltMessage | DisposedMessage

class CachedChunkWorker {
  private readonly worker: Worker
  private pending: ((message: WorkerResponse) => void) | null = null
  /** Per-cell frame count discovered when its source was added. */
  readonly frameCountByCellId = new Map<number, number>()
  constructor() {
    this.worker = new Worker(new URL("./cached-chunk-worker.ts", import.meta.url), { type: "module" })
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const cb = this.pending
      this.pending = null
      cb?.(event.data)
    }
  }
  private send<T extends WorkerResponse>(req: WorkerRequest): Promise<T> {
    if (this.pending !== null) {
      throw new Error("CachedChunkWorker: in-flight request already")
    }
    return new Promise<T>(resolve => {
      this.pending = msg => resolve(msg as T)
      this.worker.postMessage(req)
    })
  }
  init(cellWidth: number, cellHeight: number, atlasWidth: number, atlasHeight: number) {
    return this.send<InitedMessage>({ type: "init", cellWidth, cellHeight, atlasWidth, atlasHeight })
  }
  async addSource(cellId: number, source: ProbeInput): Promise<SourceAddedMessage> {
    const response = await this.send<SourceAddedMessage>({ type: "add-source", cellId, source })
    this.frameCountByCellId.set(cellId, response.frameCount)
    return response
  }
  buildChunk(cellOrder: number[], frameStart: number, frameEnd: number, cols: number, rows: number) {
    return this.send<ChunkBuiltMessage>({
      type: "build-chunk",
      cellOrder,
      frameStart,
      frameEnd,
      cols,
      rows,
    })
  }
  async dispose() {
    await this.send<DisposedMessage>({ type: "dispose" })
    this.worker.terminate()
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
  const drops = intervals.filter(i => i > mean * 1.5).reduce((a, i) => a + Math.round(i / mean) - 1, 0)
  return { framesActual: timestamps.length, framesDropped: drops, measuredFps: 1000 / mean }
}

interface RecordResult {
  clip: ProbeInput
  writerStats: { framesWritten: number; totalBytes: number; writeTotalMs: number }
  filename: string
  frameTimestamps: number[]
}

async function recordWithOpfs(stream: MediaStream, seconds: number, cellId: number): Promise<RecordResult> {
  const processorCtor = (globalThis as unknown as {
    MediaStreamTrackProcessor?: new (init: { track: MediaStreamTrack }) => {
      readable: ReadableStream<VideoFrame>
    }
  }).MediaStreamTrackProcessor
  if (processorCtor === undefined) {
    throw new Error("MediaStreamTrackProcessor unavailable")
  }
  const videoTrack = stream.getVideoTracks()[0]
  const bitmapTrack = videoTrack.clone()
  const processor = new processorCtor({ track: bitmapTrack })
  const filename = `18g-cell-${cellId}-${Date.now()}.rgba`

  const writer = new Worker(new URL("../18c_opfs-bitmaps/bitmap-writer.ts", import.meta.url), { type: "module" })
  const { promise: writerDone, resolve: resolveWriterDone } = Promise.withResolvers<WriterDoneMessage>()
  writer.onmessage = (event: MessageEvent<WriterDoneMessage>) => {
    resolveWriterDone(event.data)
  }
  writer.postMessage(
    {
      readable: processor.readable,
      bitmapWidth: params.bitmapResolution.width,
      bitmapHeight: params.bitmapResolution.height,
      filename,
    },
    [processor.readable as unknown as Transferable],
  )

  const mimeType = "video/webm;codecs=vp8,opus"
  const recorder = new MediaRecorder(stream, { mimeType })
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
  bitmapTrack.stop()
  const writerStats = await writerDone
  writer.terminate()

  const blob = new Blob(blobParts, { type: mimeType })
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  const recordedTrack = await input.getPrimaryVideoTrack()
  if (recordedTrack === null) {
    throw new Error("recordWithOpfs: no video track")
  }
  const config = await recordedTrack.getDecoderConfig()
  if (config === null) {
    throw new Error("recordWithOpfs: no decoder config")
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
    throw new Error("recordWithOpfs: no keyframe")
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
    writerStats: {
      framesWritten: writerStats.framesWritten,
      totalBytes: writerStats.totalBytes,
      writeTotalMs: writerStats.writeTotalMs,
    },
    filename,
    frameTimestamps,
  }
}

interface CellSource {
  kind: "live" | "opfs"
  cellId?: number
}

interface StageStats {
  stage: number
  cellCount: number
  bitmapKeepUpRatio: number
  gapBeforeThisTakeMs: number
  recordRenderFps: number
  recordJank: JankReport
  integrity: IntegrityReport
  opfsBytes: number
  opfsWriteTotalMs: number
  decodeMs: number
  buildChunks: Array<{ frameStart: number; frameEnd: number; compositeMs: number; atlasBytes: number }>
  buildTotalMs: number
  buildCompletedBeforeStageEnd: boolean
}

function readHeapMb(): number {
  const perf = performance as unknown as { memory?: { usedJSHeapSize: number } }
  return perf.memory ? perf.memory.usedJSHeapSize / 1_000_000 : 0
}

async function run(): Promise<void> {
  status(`progressive-overlap-chunked: ${params.stages} stages × ${params.takeSeconds}s takes, cached chunk-worker, ${params.chunkCount} chunks per build`)

  const reader = new Worker(new URL("../18c_opfs-bitmaps/bitmap-reader.ts", import.meta.url), { type: "module" })
  const latestBytes = new Map<number, { width: number; height: number; bytes: Uint8Array }>()
  reader.onmessage = (event: MessageEvent<ReaderFrameMessage>) => {
    const { cellId, width, height, bytes } = event.data
    latestBytes.set(cellId, { width, height, bytes: new Uint8Array(bytes) })
  }

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
  function makeTex(): WebGLTexture {
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return tex
  }
  const liveTex = makeTex()
  const opfsTex = makeTex()

  const cells: CellSource[] = []
  let liveActive: HTMLVideoElement | null = null
  let stop = false
  let peakHeapMb = readHeapMb()
  const stageJankRecorder = new JankRecorder()
  const longtaskObserver = observeLongTasks()
  const startWall = performance.now()
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
    if (liveActive !== null && liveActive.readyState >= 2) {
      gl.bindTexture(gl.TEXTURE_2D, liveTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, liveActive)
    }
    const N = cells.length
    if (N > 0) {
      const sliceH = 2 / N
      for (let i = 0; i < N; i++) {
        const cell = cells[i]
        const ndcY = 1 - (i + 1) * sliceH
        if (cell.kind === "live" && liveActive !== null) {
          gl.bindTexture(gl.TEXTURE_2D, liveTex)
        } else if (cell.kind === "opfs" && cell.cellId !== undefined) {
          const latest = latestBytes.get(cell.cellId)
          if (latest === undefined) {
            continue
          }
          gl.bindTexture(gl.TEXTURE_2D, opfsTex)
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            latest.width,
            latest.height,
            0,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            latest.bytes,
          )
        } else {
          continue
        }
        gl.uniform2f(uNdcOffset, -1, ndcY)
        gl.uniform2f(uNdcScale, 2, sliceH)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      }
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  // Long-lived cached chunk-worker. Init once, add sources
  // incrementally as stages stop, query builds on demand.
  const cw = new CachedChunkWorker()
  await cw.init(
    params.atlasCellWidth,
    params.atlasCellHeight,
    params.atlasResolutionWidth,
    params.atlasCellHeight, // height grows per-stage in real builds; we set a single-row size and accept that this is a simplification for v1
  )

  const clips: ProbeInput[] = []
  const stats: StageStats[] = []
  let lastStopMs: number | null = null

  // Background build queue: simple latest-wins drain loop. No
  // recursion; one loop runs in the background, picking up
  // pendingStage whenever it can.
  let pendingStage: number | null = null
  let buildLoopRunning = false
  /** Per-stage records, indexed by stage number, of build progress
   *  so the per-stage stat can be filled in async. */
  const buildProgress = new Map<number, { chunks: StageStats["buildChunks"]; totalMs: number; completedBeforeStop: boolean }>()

  async function runBuildLoop(): Promise<void> {
    if (buildLoopRunning) {
      return
    }
    buildLoopRunning = true
    while (pendingStage !== null) {
      const target = pendingStage
      pendingStage = null
      const cellOrder = Array.from({ length: target }, (_, i) => i)
      // Total frames = min framecount across cells in this build.
      let totalFrames = Number.POSITIVE_INFINITY
      for (const cid of cellOrder) {
        const f = cw.frameCountByCellId.get(cid) ?? 0
        if (f < totalFrames) {
          totalFrames = f
        }
      }
      if (totalFrames === Number.POSITIVE_INFINITY || totalFrames === 0) {
        continue
      }
      const chunkSize = Math.ceil(totalFrames / params.chunkCount)
      const chunkResults: StageStats["buildChunks"] = []
      const startMs = performance.now()
      for (let chunk = 0; chunk < params.chunkCount; chunk++) {
        if (pendingStage !== null && pendingStage > target) {
          // Superseded — abandon remaining chunks
          break
        }
        const frameStart = chunk * chunkSize
        const frameEnd = Math.min(totalFrames, frameStart + chunkSize)
        if (frameStart >= frameEnd) {
          break
        }
        const response = await cw.buildChunk(cellOrder, frameStart, frameEnd, 1, cellOrder.length)
        chunkResults.push({
          frameStart: response.frameStart,
          frameEnd: response.frameEnd,
          compositeMs: response.compositeMs,
          atlasBytes: response.atlasBytes,
        })
        if (chunk < params.chunkCount - 1) {
          await new Promise<void>(resolve => setTimeout(resolve, 0))
        }
      }
      buildProgress.set(target, {
        chunks: chunkResults,
        totalMs: performance.now() - startMs,
        completedBeforeStop: pendingStage === null || pendingStage <= target,
      })
    }
    buildLoopRunning = false
  }

  function queueBuild(forStage: number) {
    pendingStage = forStage
    void runBuildLoop()
  }

  for (let stage = 1; stage <= params.stages; stage++) {
    status(`STAGE ${stage}/${params.stages}: ${stage} cells, recording into cell ${stage - 1}...`)
    cells.push({ kind: "live" })
    liveActive = liveVideo
    stageJankRecorder.reset()
    const recordStartMs = performance.now()
    const gapBeforeThisTakeMs = lastStopMs === null ? 0 : recordStartMs - lastStopMs
    const result = await recordWithOpfs(stream, params.takeSeconds, stage - 1)
    const recordEndMs = performance.now()
    const recordJank = stageJankRecorder.snapshot()
    const recordRenderFps = recordJank.framesObserved / ((recordEndMs - recordStartMs) / 1000)

    cells[stage - 1] = { kind: "opfs", cellId: stage - 1 }
    reader.postMessage({
      type: "add-cell",
      cellId: stage - 1,
      filename: result.filename,
      frameWidth: params.bitmapResolution.width,
      frameHeight: params.bitmapResolution.height,
      frameCount: result.writerStats.framesWritten,
    })
    liveActive = null
    clips.push(result.clip)
    lastStopMs = recordEndMs
    const integrity = checkIntegrity(result.frameTimestamps)
    const heap = readHeapMb()
    if (heap > peakHeapMb) {
      peakHeapMb = heap
    }

    // Add the new clip's source to the worker's cache. This is the
    // ONLY decode pass for this clip — all subsequent builds reuse
    // the cached bitmaps.
    const sourceAdd = await cw.addSource(stage - 1, result.clip)

    // Queue a fresh build of the current cell set. Latest-wins via
    // the drain loop above.
    queueBuild(stage)

    stats.push({
      stage,
      cellCount: stage,
      bitmapKeepUpRatio: result.writerStats.framesWritten / Math.max(1, result.clip.chunks.length),
      gapBeforeThisTakeMs,
      recordRenderFps,
      recordJank,
      integrity,
      opfsBytes: result.writerStats.totalBytes,
      opfsWriteTotalMs: result.writerStats.writeTotalMs,
      decodeMs: sourceAdd.decodeMs,
      buildChunks: [],
      buildTotalMs: 0,
      buildCompletedBeforeStageEnd: false,
    })
    status(
      `  rec fps=${recordRenderFps.toFixed(1)} score=${recordJank.jankScore.toFixed(1)} ` +
        `over33=${recordJank.over33ms}(${(recordJank.over33msRatio * 100).toFixed(0)}%) streak=${recordJank.longestJankStreak} max=${recordJank.maxMs.toFixed(0)}ms; ` +
        `cam ${integrity.framesActual}f/${integrity.framesDropped}drop@${integrity.measuredFps.toFixed(1)}; ` +
        `gap=${gapBeforeThisTakeMs.toFixed(0)}ms decode=${sourceAdd.decodeMs.toFixed(0)}ms heap=${heap.toFixed(1)}MB`,
    )
  }

  status(`takes done; draining build queue...`)
  // Drain the build queue, but don't wait forever — bounded
  while (buildLoopRunning && performance.now() - startWall < 200_000) {
    await wait(100)
  }

  // Fill in build stats from buildProgress map
  for (const stat of stats) {
    const progress = buildProgress.get(stat.stage)
    if (progress) {
      stat.buildChunks = progress.chunks
      stat.buildTotalMs = progress.totalMs
      stat.buildCompletedBeforeStageEnd = progress.completedBeforeStop
    }
  }

  await cw.dispose()

  stop = true
  reader.postMessage({ type: "stop" })
  for (const track of stream.getTracks()) {
    track.stop()
  }
  liveVideo.srcObject = null
  document.body.removeChild(canvas)

  const sessionSeconds = (performance.now() - startWall) / 1000
  const longtaskReport = longtaskObserver.stop()
  status(`SESSION COMPLETE: ${sessionSeconds.toFixed(1)}s, peakHeap=${peakHeapMb.toFixed(1)}MB, longtasks=${longtaskReport.observed}`)
  status("done.")
  reportResult("progressive-overlap-chunked", params, {
    stages: stats,
    sessionSeconds,
    peakHeapMb,
    longtasks: longtaskReport satisfies LongTaskReport,
  })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("progressive-overlap-chunked", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
