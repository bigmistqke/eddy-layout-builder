// bitmap-during-record — 24g's bitmap render loop at K=16 + concurrent
// camera capture. Three isolating passes (baseline / capture-only /
// full) directly comparable to 24e's atlas equivalent.

import { wait } from "../../src/utils"
import { recordProbeInput, type ProbeInput } from "../harness/input"
import {
  JankRecorder,
  observeLongTasks,
  type JankReport,
  type LongTaskReport,
} from "../harness/jank"
import { reportResult, status } from "../harness/report"

const params = {
  captureResolution: { width: 1280, height: 720 },
  sourceSeconds: 6,
  runSeconds: 15,
  captureSeconds: 10,
  framesPerPass: 60,
  sourceFps: 30,
  opfsDirName: "24h",
  k: 16,
  gridCols: 4,
  gridRows: 4,
  cellMip: { label: "270p", width: 480, height: 272 },
  passes: [
    { label: "baseline", render: true, capture: false },
    { label: "capture-only", render: false, capture: true },
    { label: "full", render: true, capture: true },
  ],
}

const snap16 = (value: number): number => Math.max(16, Math.round(value / 16) * 16)

interface DecodedStream {
  width: number
  height: number
  frames: Uint8Array[]
}

async function decodeToRgba(
  source: ProbeInput,
  targetW: number,
  targetH: number,
  maxFrames: number,
): Promise<DecodedStream | null> {
  const width = snap16(targetW)
  const height = snap16(targetH)
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext("2d")
  if (context === null) {
    return null
  }
  const frames: Uint8Array[] = []
  const decoder = new VideoDecoder({
    output(frame) {
      if (frames.length >= maxFrames) {
        frame.close()
        return
      }
      try {
        context.drawImage(frame, 0, 0, width, height)
        const imageData = context.getImageData(0, 0, width, height)
        frames.push(new Uint8Array(imageData.data.buffer.slice(0)))
      } catch {}
      frame.close()
    },
    error() {},
  })
  decoder.configure(source.config)
  for (const chunk of source.chunks) {
    if (frames.length >= maxFrames) {
      break
    }
    decoder.decode(chunk)
  }
  try {
    await decoder.flush()
  } catch {}
  decoder.close()
  if (frames.length === 0) {
    return null
  }
  return { width, height, frames }
}

async function writeBitmapFilesToOpfs(
  frames: Uint8Array[],
  k: number,
  mipLabel: string,
): Promise<{ fileNames: string[]; writeMs: number; totalBytes: number }> {
  const start = performance.now()
  const root = await navigator.storage.getDirectory()
  const dir = await root.getDirectoryHandle(params.opfsDirName, { create: true })
  const fileNames: string[] = []
  let totalBytes = 0
  for (let cellId = 0; cellId < k; cellId++) {
    const fileName = `${mipLabel}-cell-${cellId}.bin`
    const fileHandle = await dir.getFileHandle(fileName, { create: true })
    const writable = await fileHandle.createWritable({ keepExistingData: false })
    for (const frame of frames) {
      await writable.write(frame)
      totalBytes += frame.byteLength
    }
    await writable.close()
    fileNames.push(fileName)
  }
  return { fileNames, writeMs: performance.now() - start, totalBytes }
}

async function cleanupOpfsFiles(fileNames: string[]): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle(params.opfsDirName, { create: false })
    for (const fileName of fileNames) {
      try {
        await dir.removeEntry(fileName)
      } catch {}
    }
  } catch {}
}

interface WorkerHandle {
  worker: Worker
  framesDelivered: Record<number, number>
  donePromise: Promise<void>
  ready: Promise<void>
}

function createReaderWorker(
  onFrames: (frames: { cellId: number; bytes: Uint8Array }[]) => void,
): WorkerHandle {
  // Reuse 24g's worker — same protocol.
  const worker = new Worker(
    new URL("../24g_opfs-bitmap-render/bitmap-reader-worker.ts", import.meta.url),
    { type: "module" },
  )
  const { promise: ready, resolve: resolveReady } = Promise.withResolvers<void>()
  const { promise: donePromise, resolve: resolveDone } = Promise.withResolvers<void>()
  const handle: WorkerHandle = {
    worker,
    framesDelivered: {},
    donePromise,
    ready,
  }
  worker.onmessage = (
    event: MessageEvent<
      | { type: "ready" }
      | { type: "frames"; frames: { cellId: number; bytes: ArrayBuffer }[] }
      | { type: "done"; framesDelivered: Record<number, number> }
    >,
  ) => {
    const msg = event.data
    if (msg.type === "ready") {
      resolveReady()
      return
    }
    if (msg.type === "frames") {
      onFrames(msg.frames.map(f => ({ cellId: f.cellId, bytes: new Uint8Array(f.bytes) })))
      return
    }
    if (msg.type === "done") {
      handle.framesDelivered = msg.framesDelivered
      resolveDone()
      return
    }
  }
  return handle
}

interface PassResult {
  label: string
  renderEnabled: boolean
  captureEnabled: boolean
  jank: JankReport | null
  longTasks: LongTaskReport | null
  emptyCellTicks: number | null
  captureCompleted: boolean
  captureChunkCount: number | null
}

interface GlSetup {
  canvas: HTMLCanvasElement
  gl: WebGL2RenderingContext
  uNdcOffset: WebGLUniformLocation | null
  uNdcScale: WebGLUniformLocation | null
  cleanup: () => void
}

async function setupGl(): Promise<GlSetup> {
  const canvas = document.createElement("canvas")
  canvas.width = window.innerWidth * (window.devicePixelRatio || 1)
  canvas.height = window.innerHeight * (window.devicePixelRatio || 1)
  canvas.style.cssText =
    "position:fixed;inset:0;width:100vw;height:100vh;z-index:0;display:block"
  document.body.appendChild(canvas)
  const glOrNull = canvas.getContext("webgl2")
  if (glOrNull === null) {
    document.body.removeChild(canvas)
    throw new Error("setupGl: no webgl2 context")
  }
  const gl = glOrNull

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
  vUv = vec2(corner.x, 1.0 - corner.y);
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
  const buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW)
  const aQuad = gl.getAttribLocation(program, "aQuad")
  gl.enableVertexAttribArray(aQuad)
  gl.vertexAttribPointer(aQuad, 2, gl.FLOAT, false, 0, 0)
  const uNdcOffset = gl.getUniformLocation(program, "uNdcOffset")
  const uNdcScale = gl.getUniformLocation(program, "uNdcScale")
  gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)

  const cleanup = () => {
    gl.deleteBuffer(buffer)
    gl.deleteProgram(program)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    document.body.removeChild(canvas)
  }
  return { canvas, gl, uNdcOffset, uNdcScale, cleanup }
}

async function runRenderPass(
  fileNames: string[],
  mipWidth: number,
  mipHeight: number,
): Promise<{
  jank: JankReport
  longTasks: LongTaskReport
  emptyCellTicks: number
  framesDelivered: Record<number, number>
}> {
  const latestBytes: Map<number, Uint8Array> = new Map()
  const handle = createReaderWorker(frames => {
    for (const { cellId, bytes } of frames) {
      latestBytes.set(cellId, bytes)
    }
  })
  const cellInit = fileNames.map((fileName, cellId) => ({
    cellId,
    fileName,
    frameSize: mipWidth * mipHeight * 4,
    totalFrames: params.framesPerPass,
  }))
  handle.worker.postMessage({
    type: "init",
    dirName: params.opfsDirName,
    cells: cellInit,
    sourceFps: params.sourceFps,
  })
  await handle.ready

  const waitDeadline = performance.now() + 500
  while (performance.now() < waitDeadline && latestBytes.size < params.k) {
    await wait(10)
  }

  const { gl, uNdcOffset, uNdcScale, cleanup } = await setupGl()

  const textures: WebGLTexture[] = []
  for (let i = 0; i < params.k; i++) {
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    textures.push(tex)
  }

  const recorder = new JankRecorder()
  const longTasks = observeLongTasks()
  const deadline = performance.now() + params.runSeconds * 1000
  const viewportCellW = 2 / params.gridCols
  const viewportCellH = 2 / params.gridRows
  let emptyCellTicks = 0

  await new Promise<void>(resolveLoop => {
    function tick(now: number) {
      if (now >= deadline) {
        resolveLoop()
        return
      }
      recorder.mark(now)
      gl.clear(gl.COLOR_BUFFER_BIT)
      for (let i = 0; i < params.k; i++) {
        const bytes = latestBytes.get(i)
        if (bytes === undefined) {
          emptyCellTicks++
          continue
        }
        gl.bindTexture(gl.TEXTURE_2D, textures[i])
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          mipWidth,
          mipHeight,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          bytes,
        )
        const row = Math.floor(i / params.gridCols)
        const col = i % params.gridCols
        gl.uniform2f(uNdcOffset, -1 + col * viewportCellW, 1 - (row + 1) * viewportCellH)
        gl.uniform2f(uNdcScale, viewportCellW, viewportCellH)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

  const longTaskReport = longTasks.stop()
  const jank = recorder.snapshot()

  for (const tex of textures) {
    gl.deleteTexture(tex)
  }
  cleanup()

  handle.worker.postMessage({ type: "stop" })
  await Promise.race([handle.donePromise, wait(2000)])
  handle.worker.terminate()

  return {
    jank,
    longTasks: longTaskReport,
    emptyCellTicks,
    framesDelivered: handle.framesDelivered,
  }
}

async function runPass(
  pass: (typeof params.passes)[number],
  fileNames: string[],
  mipWidth: number,
  mipHeight: number,
): Promise<PassResult> {
  let captureCompleted = false
  let captureChunkCount: number | null = null

  // Fire capture concurrently if enabled.
  let capturePromise: Promise<void> | null = null
  if (pass.capture) {
    capturePromise = recordProbeInput(
      params.captureResolution.width,
      params.captureResolution.height,
      params.captureSeconds,
    )
      .then(probe => {
        captureChunkCount = probe.chunks.length
        captureCompleted = true
      })
      .catch(() => {
        captureCompleted = false
      })
  }

  let renderResult: {
    jank: JankReport
    longTasks: LongTaskReport
    emptyCellTicks: number
  } | null = null

  if (pass.render) {
    renderResult = await runRenderPass(fileNames, mipWidth, mipHeight)
  } else {
    // No render — just wait long enough for the capture to complete.
    await wait((params.captureSeconds + 2) * 1000)
  }

  if (capturePromise !== null) {
    await Promise.race([capturePromise, wait(5000)])
  }

  return {
    label: pass.label,
    renderEnabled: pass.render,
    captureEnabled: pass.capture,
    jank: renderResult?.jank ?? null,
    longTasks: renderResult?.longTasks ?? null,
    emptyCellTicks: renderResult?.emptyCellTicks ?? null,
    captureCompleted,
    captureChunkCount,
  }
}

async function run(): Promise<void> {
  status(`bitmap-during-record: K=${params.k}, ${params.passes.length} passes × ${params.runSeconds}s`)
  status(`recording source clip (${params.sourceSeconds}s)...`)
  const source = await recordProbeInput(
    params.captureResolution.width,
    params.captureResolution.height,
    params.sourceSeconds,
  )
  status(`  got ${source.width}x${source.height}, ${source.chunks.length} chunks`)

  status(`decoding source → ${params.cellMip.width}×${params.cellMip.height} raw RGBA...`)
  const stream = await decodeToRgba(
    source,
    params.cellMip.width,
    params.cellMip.height,
    params.framesPerPass,
  )
  if (stream === null) {
    status(`  decode FAILED — aborting`)
    reportResult("bitmap-during-record", params, { error: "decode failed" })
    return
  }
  status(`  ${stream.frames.length} frames decoded`)

  status(`writing K=${params.k} OPFS bitmap files...`)
  const writeResult = await writeBitmapFilesToOpfs(stream.frames, params.k, params.cellMip.label)
  status(
    `  wrote ${writeResult.fileNames.length} files, ${(writeResult.totalBytes / 1024 / 1024).toFixed(1)} MB total in ${writeResult.writeMs.toFixed(0)}ms`,
  )
  stream.frames.length = 0

  const results: PassResult[] = []
  for (const pass of params.passes) {
    status(`PASS [${pass.label}] render=${pass.render} capture=${pass.capture}`)
    const result = await runPass(pass, writeResult.fileNames, stream.width, stream.height)
    results.push(result)
    const fps = result.jank ? (result.jank.framesObserved / params.runSeconds).toFixed(1) : "n/a"
    const over33 = result.jank ? (result.jank.over33msRatio * 100).toFixed(1) + "%" : "n/a"
    const streak = result.jank?.longestJankStreak ?? "n/a"
    const cap = result.captureEnabled ? (result.captureCompleted ? `ok ${result.captureChunkCount} chunks` : "failed") : "n/a"
    const empty = result.emptyCellTicks ?? "n/a"
    const lt = result.longTasks?.observed ?? "n/a"
    status(`  fps=${fps} over33=${over33} streak=${streak} empty=${empty} capture=${cap} longtasks=${lt}`)
    // brief pause between passes for the device to cool / IPC to settle
    await wait(2000)
  }

  await cleanupOpfsFiles(writeResult.fileNames)
  status("done.")
  reportResult("bitmap-during-record", params, { passes: results })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("bitmap-during-record", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
