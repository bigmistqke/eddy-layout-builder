// yielding-build (a.k.a. temporal-chunks spike) — compare three build
// modes for the same atlas content, all concurrent with render +
// capture: baseline (no build), mono (one big worker job), chunked
// (3 sequential chunks with main-thread yields between).
//
// Tests whether smaller per-chunk work plus yields softens the
// rebuild contention 18c surfaced. Atlas output isn't consumed by the
// renderer here — we're only measuring *build* jank, not the eventual
// chunk-decode render path.

import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from "mediabunny"
import { wait } from "../../src/utils"
import type { ProbeInput } from "../harness/input"
import { recordProbeInput } from "../harness/input"
import { JankRecorder, observeLongTasks, type JankReport, type LongTaskReport } from "../harness/jank"
import { reportResult, status } from "../harness/report"
import type { ChunkAtlas } from "./composite-chunk"

const params = {
  captureResolution: { width: 1280, height: 720 },
  canvasResolution: { width: 540, height: 982 },
  // K=4 cells per atlas (2x2) — matches 10/11's K=4 verdict.
  atlasCols: 2,
  atlasRows: 2,
  atlasResolution: { width: 540, height: 982 },
  sourceSeconds: 6,
  passSeconds: 12, // long enough to cover mono build (~7s) + slack
  // Render load: K textures uploaded per frame from pre-allocated
  // Uint8Arrays. Models 18c's OPFS-bitmap paint load without the
  // setup cost of actual OPFS streaming.
  renderCells: 8,
  renderCellWidth: 128,
  renderCellHeight: 232,
}

interface BuildEvent {
  /** Wall-clock when this chunk-built event fired, relative to pass start. */
  atMsSincePassStart: number
  atlasBytes: number
  buildMs: number
  frameStart: number
  frameEnd: number
}

interface PassReport {
  label: "baseline" | "mono" | "chunked"
  jank: JankReport
  buildEvents: BuildEvent[]
  totalBuildMs: number
  captureFrames: number
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
    this.worker = new Worker(new URL("./chunk-worker.ts", import.meta.url), { type: "module" })
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const cb = this.pending
      this.pending = null
      cb?.(event.data)
    }
  }
  private send<T extends WorkerResponse>(req: PrepareRequest | BuildChunkRequest | DisposeRequest): Promise<T> {
    if (this.pending !== null) {
      throw new Error("ChunkWorker: in-flight request already")
    }
    return new Promise<T>(resolve => {
      this.pending = msg => resolve(msg as T)
      this.worker.postMessage(req)
    })
  }
  prepare(sources: ProbeInput[]): Promise<PreparedMessage> {
    return this.send<PreparedMessage>({
      type: "prepare",
      sources,
      cols: params.atlasCols,
      rows: params.atlasRows,
      atlasWidth: params.atlasResolution.width,
      atlasHeight: params.atlasResolution.height,
    })
  }
  buildChunk(frameStart: number, frameEnd: number): Promise<ChunkBuiltMessage> {
    return this.send<ChunkBuiltMessage>({ type: "build-chunk", frameStart, frameEnd })
  }
  async dispose(): Promise<void> {
    await this.send<DisposedMessage>({ type: "dispose" })
    this.worker.terminate()
  }
}

async function captureForSeconds(seconds: number): Promise<{ frames: number }> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: params.captureResolution.width, height: params.captureResolution.height },
    audio: true,
  })
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
  for (const track of stream.getTracks()) {
    track.stop()
  }
  const blob = new Blob(blobParts, { type: "video/webm;codecs=vp8,opus" })
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  const videoTrack = await input.getPrimaryVideoTrack()
  if (videoTrack === null) {
    return { frames: 0 }
  }
  const sink = new EncodedPacketSink(videoTrack)
  let frames = 0
  for await (const _packet of sink.packets()) {
    frames++
  }
  return { frames }
}

async function runPass(
  label: PassReport["label"],
  mode: "baseline" | "mono" | "chunked",
  composer: ChunkWorker,
  totalFrames: number,
  paintBytes: Uint8Array,
  gl: WebGL2RenderingContext,
  textures: WebGLTexture[],
  uniforms: {
    uNdcOffset: WebGLUniformLocation
    uNdcScale: WebGLUniformLocation
  },
): Promise<PassReport> {
  const recorder = new JankRecorder()
  const passStart = performance.now()
  let stopRender = false
  function tick() {
    if (stopRender) {
      return
    }
    recorder.mark()
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    // Upload all K textures from the shared bytes (simulates per-cell
    // OPFS-bitmap render load).
    for (let i = 0; i < params.renderCells; i++) {
      gl.bindTexture(gl.TEXTURE_2D, textures[i])
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        params.renderCellWidth,
        params.renderCellHeight,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        paintBytes,
      )
      const sliceH = 2 / params.renderCells
      const ndcY = 1 - (i + 1) * sliceH
      gl.uniform2f(uniforms.uNdcOffset, -1, ndcY)
      gl.uniform2f(uniforms.uNdcScale, 2, sliceH)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  const buildEvents: BuildEvent[] = []
  const buildPromise = (async (): Promise<number> => {
    if (mode === "baseline") {
      return 0
    }
    const buildStart = performance.now()
    if (mode === "mono") {
      const response = await composer.buildChunk(0, totalFrames)
      buildEvents.push({
        atMsSincePassStart: performance.now() - passStart,
        atlasBytes: response.chunk.atlasBytes,
        buildMs: response.chunk.compositeMs,
        frameStart: response.chunk.frameStart,
        frameEnd: response.chunk.frameEnd,
      })
    } else {
      // 3 chunks. Yield to main between chunks so the scheduler can
      // prioritise rAF + capture before next chunk runs.
      const chunkSize = Math.ceil(totalFrames / 3)
      for (let chunk = 0; chunk < 3; chunk++) {
        const frameStart = chunk * chunkSize
        const frameEnd = Math.min(totalFrames, frameStart + chunkSize)
        if (frameStart >= frameEnd) {
          break
        }
        const response = await composer.buildChunk(frameStart, frameEnd)
        buildEvents.push({
          atMsSincePassStart: performance.now() - passStart,
          atlasBytes: response.chunk.atlasBytes,
          buildMs: response.chunk.compositeMs,
          frameStart: response.chunk.frameStart,
          frameEnd: response.chunk.frameEnd,
        })
        if (chunk < 2) {
          // Yield. setTimeout(0) is the simplest "let other stuff run"
          // primitive that works everywhere. scheduler.postTask with
          // background priority would be slightly more polite where
          // supported.
          await new Promise<void>(resolve => setTimeout(resolve, 0))
        }
      }
    }
    return performance.now() - buildStart
  })()

  const [capture, totalBuildMs] = await Promise.all([
    captureForSeconds(params.passSeconds),
    buildPromise,
  ])
  stopRender = true
  await wait(50)
  return {
    label,
    jank: recorder.snapshot(),
    buildEvents,
    totalBuildMs,
    captureFrames: capture.frames,
  }
}

async function run(): Promise<void> {
  status(`yielding-build session: 3 passes × ${params.passSeconds}s`)

  status(`recording source clip (${params.sourceSeconds}s)...`)
  const source = await recordProbeInput(
    params.captureResolution.width,
    params.captureResolution.height,
    params.sourceSeconds,
  )
  status(`  got ${source.width}x${source.height}, ${source.chunks.length} chunks`)

  // Render loop simulated load: K = renderCells, all using a shared
  // pre-allocated byte array as texture source.
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
  const uniforms = {
    uNdcOffset: gl.getUniformLocation(program, "uNdcOffset")!,
    uNdcScale: gl.getUniformLocation(program, "uNdcScale")!,
  }
  const textures: WebGLTexture[] = []
  for (let i = 0; i < params.renderCells; i++) {
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    textures.push(tex)
  }
  const paintBytes = new Uint8Array(params.renderCellWidth * params.renderCellHeight * 4)
  for (let i = 0; i < paintBytes.length; i += 4) {
    paintBytes[i] = (i / 4) & 0xff
    paintBytes[i + 1] = 0x80
    paintBytes[i + 2] = 0xff - ((i / 4) & 0xff)
    paintBytes[i + 3] = 0xff
  }

  // Prepare the composer once (pre-decodes the sources). Same composer
  // used for all 3 passes — gives mono and chunked the same baseline.
  status(`preparing chunk composer (pre-decoding sources)...`)
  const composer = new ChunkWorker()
  // K cells: just use the same source K times (matches 18c pattern).
  const sources: ProbeInput[] = Array.from(
    { length: params.atlasCols * params.atlasRows },
    () => source,
  )
  const prepared = await composer.prepare(sources)
  status(`  ready, totalFrames=${prepared.totalFrames}`)

  const longtaskObserver = observeLongTasks()
  const passes: PassReport[] = []

  for (const mode of ["baseline", "mono", "chunked"] as const) {
    status(`PASS [${mode}] — render + capture${mode === "baseline" ? "" : " + " + mode + " build"}...`)
    const report = await runPass(
      mode,
      mode,
      composer,
      prepared.totalFrames,
      paintBytes,
      gl,
      textures,
      uniforms,
    )
    const j = report.jank
    status(
      `  [${mode}] frames=${j.framesObserved} mean=${j.meanMs.toFixed(1)}ms p95=${j.p95Ms.toFixed(1)}ms p99=${j.p99Ms.toFixed(1)}ms max=${j.maxMs.toFixed(1)}ms ` +
        `over33=${j.over33ms}(${(j.over33msRatio * 100).toFixed(0)}%) streak=${j.longestJankStreak} score=${j.jankScore.toFixed(1)}; ` +
        `build ${report.buildEvents.length} chunks, total ${report.totalBuildMs.toFixed(0)}ms; capture ${report.captureFrames}f`,
    )
    passes.push(report)
  }

  await composer.dispose()
  document.body.removeChild(canvas)
  const longtaskReport = longtaskObserver.stop()
  status(`done. longtasks=${longtaskReport.observed} (total ${longtaskReport.totalDurationMs.toFixed(0)}ms, longest ${longtaskReport.longestMs.toFixed(0)}ms)`)
  reportResult("yielding-build", params, {
    passes,
    longtasks: longtaskReport satisfies LongTaskReport,
  })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("yielding-build", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
