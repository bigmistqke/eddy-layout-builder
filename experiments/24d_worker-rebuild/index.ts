// worker-rebuild — same edit-stream + serial-rebuild scaffold as
// 24c, but the rebuild (decode source + composite + AV1 encode)
// happens in a Web Worker via rebuild-worker.ts. Tests whether
// moving rebuild off the main thread restores near-uncontended
// build cost.

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
  runSeconds: 20,
  bitratePerPixel: 0.1,
  swCodec: { label: "av1", codecString: "av01.0.04M.08" },
  k: 16,
  m: 4,
  atlasCols: 2,
  atlasRows: 2,
  gridCols: 4,
  gridRows: 4,
  cellMip: { width: 480, height: 272 },
  editRates: [0.25, 0.5, 1.0, 2.0],
}

interface RawChunk {
  type: EncodedVideoChunkType
  timestamp: number
  duration: number | null
  data: ArrayBuffer
}

interface MipAsset {
  width: number
  height: number
  config: VideoDecoderConfig
  chunks: EncodedVideoChunk[]
}

interface AtlasAsset extends MipAsset {
  atlasCols: number
  atlasRows: number
  cellWidth: number
  cellHeight: number
  buildMs: number
}

const snap16 = (value: number): number => Math.max(16, Math.round(value / 16) * 16)

function chunksToRaw(chunks: EncodedVideoChunk[]): RawChunk[] {
  return chunks.map(chunk => {
    const buffer = new ArrayBuffer(chunk.byteLength)
    chunk.copyTo(new Uint8Array(buffer))
    return {
      type: chunk.type,
      timestamp: chunk.timestamp,
      duration: chunk.duration ?? null,
      data: buffer,
    }
  })
}

function rawToChunks(raw: RawChunk[]): EncodedVideoChunk[] {
  return raw.map(
    r =>
      new EncodedVideoChunk({
        type: r.type,
        timestamp: r.timestamp,
        duration: r.duration ?? undefined,
        data: r.data,
      }),
  )
}

interface RebuildWorker {
  build(): Promise<AtlasAsset | null>
  terminate(): void
}

async function createRebuildWorker(source: ProbeInput): Promise<RebuildWorker> {
  const worker = new Worker(
    new URL("./rebuild-worker.ts", import.meta.url),
    { type: "module" },
  )
  const { promise: ready, resolve: resolveReady } = Promise.withResolvers<void>()
  const initHandler = (event: MessageEvent<{ type: string }>) => {
    if (event.data.type === "ready") {
      resolveReady()
      worker.removeEventListener("message", initHandler)
    }
  }
  worker.addEventListener("message", initHandler)
  const sourceChunks = chunksToRaw(source.chunks)
  worker.postMessage(
    {
      type: "init",
      sourceConfig: source.config,
      sourceChunks,
    },
    sourceChunks.map(c => c.data),
  )
  await ready

  let nextJobId = 0
  return {
    async build(): Promise<AtlasAsset | null> {
      const jobId = nextJobId++
      const { promise, resolve } = Promise.withResolvers<AtlasAsset | null>()
      const handler = (event: MessageEvent<{
        type: string
        jobId: number
        ok: boolean
        decoderConfig: VideoDecoderConfig | null
        chunks: RawChunk[]
        buildMs: number
      }>) => {
        if (event.data.type !== "done" || event.data.jobId !== jobId) {
          return
        }
        worker.removeEventListener("message", handler)
        if (!event.data.ok || event.data.decoderConfig === null) {
          resolve(null)
          return
        }
        const cellWidth = snap16(params.cellMip.width)
        const cellHeight = snap16(params.cellMip.height)
        resolve({
          width: cellWidth * params.atlasCols,
          height: cellHeight * params.atlasRows,
          cellWidth,
          cellHeight,
          atlasCols: params.atlasCols,
          atlasRows: params.atlasRows,
          config: event.data.decoderConfig,
          chunks: rawToChunks(event.data.chunks),
          buildMs: event.data.buildMs,
        })
      }
      worker.addEventListener("message", handler)
      worker.postMessage({
        type: "build",
        jobId,
        atlasCols: params.atlasCols,
        atlasRows: params.atlasRows,
        cellWidth: snap16(params.cellMip.width),
        cellHeight: snap16(params.cellMip.height),
        codecString: params.swCodec.codecString,
        bitratePerPixel: params.bitratePerPixel,
        framerate: 30,
      })
      return promise
    },
    terminate(): void {
      worker.terminate()
    },
  }
}

async function transcodePerCellMip(
  source: ProbeInput,
  mipW: number,
  mipH: number,
): Promise<MipAsset | null> {
  const width = snap16(mipW)
  const height = snap16(mipH)
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext("2d")
  if (context === null) {
    return null
  }
  const chunks: EncodedVideoChunk[] = []
  let decoderConfig: VideoDecoderConfig | null = null
  const bitrate = Math.round(width * height * 30 * params.bitratePerPixel)
  const encoder = new VideoEncoder({
    output(chunk, metadata) {
      chunks.push(chunk)
      if (decoderConfig === null && metadata?.decoderConfig) {
        decoderConfig = metadata.decoderConfig
      }
    },
    error() {},
  })
  try {
    encoder.configure({
      codec: params.swCodec.codecString,
      width,
      height,
      bitrate,
      framerate: 30,
    })
  } catch {
    encoder.close()
    return null
  }
  let frameIdx = 0
  const sourceDecoder = new VideoDecoder({
    output(frame) {
      try {
        context.drawImage(frame, 0, 0, width, height)
        const scaled = new VideoFrame(canvas, { timestamp: frame.timestamp })
        encoder.encode(scaled, { keyFrame: frameIdx === 0 })
        scaled.close()
      } catch {}
      frame.close()
      frameIdx++
    },
    error() {},
  })
  sourceDecoder.configure(source.config)
  for (const chunk of source.chunks) {
    sourceDecoder.decode(chunk)
  }
  await sourceDecoder.flush()
  sourceDecoder.close()
  try {
    await encoder.flush()
  } catch {}
  encoder.close()
  if (chunks.length === 0 || decoderConfig === null) {
    return null
  }
  return { width, height, config: decoderConfig, chunks }
}

interface PacedDecoder {
  latestFrame(): VideoFrame | null
  feedTo(elapsedMs: number, targetFps: number): void
  framesDecoded(): number
  stop(): void
}

function makePacedDecoder(asset: MipAsset): PacedDecoder {
  let latest: VideoFrame | null = null
  let cursor = 0
  let framesDecoded = 0
  const decoder = new VideoDecoder({
    output(frame) {
      framesDecoded++
      if (latest !== null) {
        latest.close()
      }
      latest = frame
    },
    error() {},
  })
  try {
    decoder.configure({ ...asset.config, hardwareAcceleration: "prefer-software" })
  } catch {}
  return {
    latestFrame: () => latest,
    framesDecoded: () => framesDecoded,
    feedTo(elapsedMs, targetFps) {
      const targetCursor = Math.floor((elapsedMs * targetFps) / 1000) + 1
      while (cursor < targetCursor && decoder.decodeQueueSize < 4) {
        const chunkIdx = cursor % asset.chunks.length
        decoder.decode(asset.chunks[chunkIdx])
        cursor++
      }
    },
    stop() {
      if (latest !== null) {
        latest.close()
        latest = null
      }
      try {
        decoder.close()
      } catch {}
    },
  }
}

interface PassResult {
  editRate: number
  editsApplied: number
  editsSkipped: number
  rebuildsCompleted: number
  meanRebuildMs: number
  maxRebuildMs: number
  maxD: number
  meanD: number
  p95D: number
  totalFramesDecoded: number
  aggregateDecodeFps: number
  jank: JankReport
  longTasks: LongTaskReport
}

async function runPass(
  source: ProbeInput,
  initialAtlases: AtlasAsset[],
  perCellMip: MipAsset,
  editRate: number,
): Promise<{ result: PassResult; dSamples: number[] }> {
  const rebuildWorker = await createRebuildWorker(source)

  const canvas = document.createElement("canvas")
  canvas.width = window.innerWidth * (window.devicePixelRatio || 1)
  canvas.height = window.innerHeight * (window.devicePixelRatio || 1)
  canvas.style.cssText =
    "position:fixed;inset:0;width:100vw;height:100vh;z-index:0;display:block"
  document.body.appendChild(canvas)
  const glOrNull = canvas.getContext("webgl2")
  if (glOrNull === null) {
    document.body.removeChild(canvas)
    rebuildWorker.terminate()
    throw new Error("runPass: no webgl2 context")
  }
  const gl = glOrNull

  const vs = gl.createShader(gl.VERTEX_SHADER)!
  gl.shaderSource(
    vs,
    `#version 300 es
in vec2 aQuad;
uniform vec2 uNdcOffset;
uniform vec2 uNdcScale;
uniform vec2 uUvOffset;
uniform vec2 uUvScale;
out vec2 vUv;
void main() {
  vec2 corner = (aQuad + 1.0) * 0.5;
  vec2 cornerFlipY = vec2(corner.x, 1.0 - corner.y);
  vUv = uUvOffset + cornerFlipY * uUvScale;
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
  const uUvOffset = gl.getUniformLocation(program, "uUvOffset")
  const uUvScale = gl.getUniformLocation(program, "uUvScale")
  gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)

  const cellAtlas: number[] = []
  for (let i = 0; i < params.k; i++) {
    cellAtlas.push(i % params.m)
  }
  const cellSlotInAtlas: number[] = new Array(params.k).fill(0)
  {
    const slotCounters = new Array<number>(params.m).fill(0)
    for (let i = 0; i < params.k; i++) {
      cellSlotInAtlas[i] = slotCounters[cellAtlas[i]]++
    }
  }
  const atlasDecoders: PacedDecoder[] = initialAtlases.map(makePacedDecoder)
  const atlasTextures = initialAtlases.map(() => {
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return tex
  })

  const perCellDecoders: Map<number, PacedDecoder> = new Map()
  const perCellTextures: Map<number, WebGLTexture> = new Map()
  const cellDirty: boolean[] = new Array(params.k).fill(false)

  function makePerCellTexture(): WebGLTexture {
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return tex
  }

  const rebuildQueue: number[] = []
  let rebuildInProgress = false
  const rebuildTimes: number[] = []
  let rebuildsCompleted = 0

  function enqueueRebuild(atlasIdx: number): void {
    if (rebuildQueue.includes(atlasIdx)) {
      return
    }
    rebuildQueue.push(atlasIdx)
  }

  async function maybeStartRebuild(): Promise<void> {
    if (rebuildInProgress || rebuildQueue.length === 0) {
      return
    }
    rebuildInProgress = true
    const atlasIdx = rebuildQueue.shift()!
    const newAsset = await rebuildWorker.build()
    if (newAsset === null) {
      rebuildInProgress = false
      return
    }
    const oldDecoder = atlasDecoders[atlasIdx]
    atlasDecoders[atlasIdx] = makePacedDecoder(newAsset)
    oldDecoder.stop()
    for (let i = 0; i < params.k; i++) {
      if (cellAtlas[i] === atlasIdx && cellDirty[i]) {
        cellDirty[i] = false
        const dec = perCellDecoders.get(i)
        if (dec !== undefined) {
          dec.stop()
          perCellDecoders.delete(i)
        }
        const tex = perCellTextures.get(i)
        if (tex !== undefined) {
          gl.deleteTexture(tex)
          perCellTextures.delete(i)
        }
      }
    }
    rebuildTimes.push(newAsset.buildMs)
    rebuildsCompleted++
    rebuildInProgress = false
  }

  let editsApplied = 0
  let editsSkipped = 0

  function applyEdit(): void {
    const cleanIndices: number[] = []
    for (let i = 0; i < params.k; i++) {
      if (!cellDirty[i]) {
        cleanIndices.push(i)
      }
    }
    if (cleanIndices.length === 0) {
      editsSkipped++
      return
    }
    const cellId = cleanIndices[Math.floor(Math.random() * cleanIndices.length)]
    cellDirty[cellId] = true
    perCellDecoders.set(cellId, makePacedDecoder(perCellMip))
    perCellTextures.set(cellId, makePerCellTexture())
    enqueueRebuild(cellAtlas[cellId])
    editsApplied++
  }

  const recorder = new JankRecorder()
  const longTasks = observeLongTasks()
  const dSamples: number[] = []
  const deadline = performance.now() + params.runSeconds * 1000
  const startWall = performance.now()
  const targetFps = 30
  const editIntervalMs = 1000 / editRate
  let nextEditAtMs = editIntervalMs

  await new Promise<void>(resolveLoop => {
    function tick(now: number) {
      if (now >= deadline) {
        resolveLoop()
        return
      }
      recorder.mark(now)
      const elapsedMs = now - startWall

      while (elapsedMs >= nextEditAtMs) {
        applyEdit()
        nextEditAtMs += editIntervalMs
      }

      void maybeStartRebuild()

      let currentD = 0
      for (let i = 0; i < params.k; i++) {
        if (cellDirty[i]) {
          currentD++
        }
      }
      dSamples.push(currentD)

      for (const decoder of atlasDecoders) {
        decoder.feedTo(elapsedMs, targetFps)
      }
      for (const decoder of perCellDecoders.values()) {
        decoder.feedTo(elapsedMs, targetFps)
      }

      gl.clear(gl.COLOR_BUFFER_BIT)

      for (let i = 0; i < atlasDecoders.length; i++) {
        const frame = atlasDecoders[i].latestFrame()
        if (frame === null) {
          continue
        }
        gl.bindTexture(gl.TEXTURE_2D, atlasTextures[i])
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame)
      }
      for (const [cellId, decoder] of perCellDecoders) {
        const frame = decoder.latestFrame()
        if (frame === null) {
          continue
        }
        const tex = perCellTextures.get(cellId)
        if (tex === undefined) {
          continue
        }
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame)
      }

      const viewportCellW = 2 / params.gridCols
      const viewportCellH = 2 / params.gridRows
      for (let i = 0; i < params.k; i++) {
        const row = Math.floor(i / params.gridCols)
        const col = i % params.gridCols
        const ndcX = -1 + col * viewportCellW
        const ndcY = 1 - (row + 1) * viewportCellH
        if (cellDirty[i]) {
          const tex = perCellTextures.get(i)
          if (tex === undefined) {
            continue
          }
          gl.bindTexture(gl.TEXTURE_2D, tex)
          gl.uniform2f(uUvOffset, 0, 0)
          gl.uniform2f(uUvScale, 1, 1)
        } else {
          gl.bindTexture(gl.TEXTURE_2D, atlasTextures[cellAtlas[i]])
          const slot = cellSlotInAtlas[i]
          const tileRow = Math.floor(slot / params.atlasCols)
          const tileCol = slot % params.atlasCols
          gl.uniform2f(uUvOffset, tileCol / params.atlasCols, 1 - (tileRow + 1) / params.atlasRows)
          gl.uniform2f(uUvScale, 1 / params.atlasCols, 1 / params.atlasRows)
        }
        gl.uniform2f(uNdcOffset, ndcX, ndcY)
        gl.uniform2f(uNdcScale, viewportCellW, viewportCellH)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

  const waitDeadline = performance.now() + 10000
  while (rebuildInProgress && performance.now() < waitDeadline) {
    await wait(50)
  }

  const longTaskReport = longTasks.stop()
  const jank = recorder.snapshot()
  const elapsedSec = (performance.now() - startWall) / 1000
  let totalFramesDecoded = 0
  for (const dec of atlasDecoders) {
    totalFramesDecoded += dec.framesDecoded()
  }
  for (const dec of perCellDecoders.values()) {
    totalFramesDecoded += dec.framesDecoded()
  }

  for (const decoder of atlasDecoders) {
    decoder.stop()
  }
  for (const decoder of perCellDecoders.values()) {
    decoder.stop()
  }
  for (const tex of atlasTextures) {
    gl.deleteTexture(tex)
  }
  for (const tex of perCellTextures.values()) {
    gl.deleteTexture(tex)
  }
  gl.deleteBuffer(buffer)
  gl.deleteProgram(program)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  document.body.removeChild(canvas)
  rebuildWorker.terminate()

  const sortedD = dSamples.slice().sort((a, b) => a - b)
  const p95D = sortedD[Math.min(sortedD.length - 1, Math.floor(sortedD.length * 0.95))] ?? 0
  const meanD = dSamples.reduce((s, x) => s + x, 0) / Math.max(1, dSamples.length)
  const meanRebuildMs =
    rebuildTimes.length === 0 ? 0 : rebuildTimes.reduce((s, x) => s + x, 0) / rebuildTimes.length
  const maxRebuildMs = rebuildTimes.length === 0 ? 0 : Math.max(...rebuildTimes)

  return {
    result: {
      editRate,
      editsApplied,
      editsSkipped,
      rebuildsCompleted,
      meanRebuildMs,
      maxRebuildMs,
      maxD: Math.max(0, ...dSamples),
      meanD,
      p95D,
      totalFramesDecoded,
      aggregateDecodeFps: totalFramesDecoded / elapsedSec,
      jank,
      longTasks: longTaskReport,
    },
    dSamples,
  }
}

/** One-shot inline atlas build for the initial M atlases — same as
 *  the per-cell mip transcoder shape. */
async function buildInitialAtlas(source: ProbeInput): Promise<AtlasAsset | null> {
  const start = performance.now()
  const cellWidth = snap16(params.cellMip.width)
  const cellHeight = snap16(params.cellMip.height)
  const width = cellWidth * params.atlasCols
  const height = cellHeight * params.atlasRows
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext("2d")
  if (context === null) {
    return null
  }
  const chunks: EncodedVideoChunk[] = []
  let decoderConfig: VideoDecoderConfig | null = null
  const bitrate = Math.round(width * height * 30 * params.bitratePerPixel)
  const encoder = new VideoEncoder({
    output(chunk, metadata) {
      chunks.push(chunk)
      if (decoderConfig === null && metadata?.decoderConfig) {
        decoderConfig = metadata.decoderConfig
      }
    },
    error() {},
  })
  try {
    encoder.configure({
      codec: params.swCodec.codecString,
      width,
      height,
      bitrate,
      framerate: 30,
    })
  } catch {
    encoder.close()
    return null
  }
  let frameIdx = 0
  const sourceDecoder = new VideoDecoder({
    output(frame) {
      try {
        for (let row = 0; row < params.atlasRows; row++) {
          for (let col = 0; col < params.atlasCols; col++) {
            context.drawImage(frame, col * cellWidth, row * cellHeight, cellWidth, cellHeight)
          }
        }
        const atlasFrame = new VideoFrame(canvas, { timestamp: frame.timestamp })
        encoder.encode(atlasFrame, { keyFrame: frameIdx === 0 })
        atlasFrame.close()
      } catch {}
      frame.close()
      frameIdx++
    },
    error() {},
  })
  sourceDecoder.configure(source.config)
  for (const chunk of source.chunks) {
    sourceDecoder.decode(chunk)
  }
  await sourceDecoder.flush()
  sourceDecoder.close()
  try {
    await encoder.flush()
  } catch {}
  encoder.close()
  if (chunks.length === 0 || decoderConfig === null) {
    return null
  }
  return {
    width,
    height,
    cellWidth,
    cellHeight,
    atlasCols: params.atlasCols,
    atlasRows: params.atlasRows,
    config: decoderConfig,
    chunks,
    buildMs: performance.now() - start,
  }
}

async function run(): Promise<void> {
  status(
    `worker-rebuild: K=${params.k} M=${params.m} run=${params.runSeconds}s × ${params.editRates.length} rates`,
  )
  status(`recording VP8 source clip (${params.sourceSeconds}s)...`)
  const source = await recordProbeInput(
    params.captureResolution.width,
    params.captureResolution.height,
    params.sourceSeconds,
  )
  status(`  got ${source.width}x${source.height}, ${source.chunks.length} chunks`)

  status(`building initial ${params.m} AV1 atlases...`)
  const atlases: AtlasAsset[] = []
  for (let i = 0; i < params.m; i++) {
    const asset = await buildInitialAtlas(source)
    if (asset === null) {
      status(`  atlas ${i} build FAILED — aborting`)
      reportResult("worker-rebuild", params, { error: "initial atlas build failed" })
      return
    }
    atlases.push(asset)
    status(`  atlas ${i}: ${asset.width}×${asset.height} ${asset.chunks.length} chunks (${asset.buildMs.toFixed(0)}ms)`)
  }

  status(`transcoding per-cell mip ${params.cellMip.width}×${params.cellMip.height}...`)
  const perCellMip = await transcodePerCellMip(source, params.cellMip.width, params.cellMip.height)
  if (perCellMip === null) {
    status(`  per-cell mip FAILED — aborting`)
    reportResult("worker-rebuild", params, { error: "per-cell mip transcode failed" })
    return
  }
  status(`  per-cell mip: ${perCellMip.chunks.length} chunks`)

  const results: PassResult[] = []
  const dTraces: Record<string, number[]> = {}
  for (const editRate of params.editRates) {
    status(`PASS editRate=${editRate}/s`)
    const { result, dSamples } = await runPass(source, atlases, perCellMip, editRate)
    results.push(result)
    dTraces[`rate-${editRate}`] = dSamples
    status(
      `  fps=${(result.jank.framesObserved / params.runSeconds).toFixed(1)} ` +
        `over33=${(result.jank.over33msRatio * 100).toFixed(1)}% ` +
        `streak=${result.jank.longestJankStreak} ` +
        `meanD=${result.meanD.toFixed(2)} p95D=${result.p95D} maxD=${result.maxD} ` +
        `edits=${result.editsApplied}+${result.editsSkipped}sk ` +
        `rebuilds=${result.rebuildsCompleted}@mean=${result.meanRebuildMs.toFixed(0)}ms (max=${result.maxRebuildMs.toFixed(0)}) ` +
        `longtasks=${result.longTasks.observed}`,
    )
  }
  status("done.")
  reportResult("worker-rebuild", params, { passes: results, dTraces })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("worker-rebuild", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
