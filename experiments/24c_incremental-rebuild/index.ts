// incremental-rebuild — simulates an edit stream + serial atlas
// rebuilds running concurrent with the K=16/M=4 render loop, sweeping
// edit rate. Measures whether the dirty-cell count D stays bounded
// and whether render fps survives.

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
  /** Edits per second sweep. */
  editRates: [0.25, 0.5, 1.0, 2.0],
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

async function buildAtlas(source: ProbeInput): Promise<AtlasAsset | null> {
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
  dSamples: number[]
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
  atlases: AtlasAsset[],
  perCellMip: MipAsset,
  editRate: number,
): Promise<PassResult> {
  // Render setup mirrors 24a/24b.
  const canvas = document.createElement("canvas")
  canvas.width = window.innerWidth * (window.devicePixelRatio || 1)
  canvas.height = window.innerHeight * (window.devicePixelRatio || 1)
  canvas.style.cssText =
    "position:fixed;inset:0;width:100vw;height:100vh;z-index:0;display:block"
  document.body.appendChild(canvas)
  const glOrNull = canvas.getContext("webgl2")
  if (glOrNull === null) {
    document.body.removeChild(canvas)
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

  // Per-cell state.
  const cellAtlas: number[] = []
  for (let i = 0; i < params.k; i++) {
    cellAtlas.push(i % params.m) // round-robin assignment, matches 24a
  }
  const cellSlotInAtlas: number[] = new Array(params.k).fill(0)
  {
    const slotCounters = new Array<number>(params.m).fill(0)
    for (let i = 0; i < params.k; i++) {
      cellSlotInAtlas[i] = slotCounters[cellAtlas[i]]++
    }
  }
  // Atlas decoders + textures, mutable so we can swap on rebuild.
  let atlasDecoders: PacedDecoder[] = atlases.map(makePacedDecoder)
  const atlasTextures = atlases.map(() => {
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return tex
  })

  // Per-cell decoders (sparse — only for dirty cells).
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

  // Rebuild scheduler state.
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
    const rebuildStart = performance.now()
    const newAsset = await buildAtlas(source)
    const rebuildMs = performance.now() - rebuildStart
    if (newAsset === null) {
      rebuildInProgress = false
      return
    }
    // Swap atlas decoder. Naive: stop old, start new. No pre-warm
    // (per 14/16 that's a separate optimization).
    const oldDecoder = atlasDecoders[atlasIdx]
    atlasDecoders[atlasIdx] = makePacedDecoder(newAsset)
    oldDecoder.stop()
    // Mark all cells in this atlas as clean; tear down their per-cell
    // decoders.
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
    // Free chunks of the rebuilt asset (we keep a reference via the
    // new paced decoder's closure, but rendering reads decoded
    // frames not chunks; chunks needed only until decode catches up.
    // For simplicity, keep chunks alive for this asset.)
    rebuildTimes.push(rebuildMs)
    rebuildsCompleted++
    rebuildInProgress = false
    // newAsset.chunks is kept alive by the paced decoder closure.
  }

  let editsApplied = 0
  let editsSkipped = 0

  function applyEdit(): void {
    // Pick a random clean cell.
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

      // Edit scheduler — apply edits whose time has come.
      while (elapsedMs >= nextEditAtMs) {
        applyEdit()
        nextEditAtMs += editIntervalMs
      }

      // Kick off rebuild if idle (async, runs concurrently with rAF).
      void maybeStartRebuild()

      // Record current D.
      let currentD = 0
      for (let i = 0; i < params.k; i++) {
        if (cellDirty[i]) {
          currentD++
        }
      }
      dSamples.push(currentD)

      // Drive all active decoders.
      for (const decoder of atlasDecoders) {
        decoder.feedTo(elapsedMs, targetFps)
      }
      for (const decoder of perCellDecoders.values()) {
        decoder.feedTo(elapsedMs, targetFps)
      }

      gl.clear(gl.COLOR_BUFFER_BIT)

      // Upload latest frames — M atlases + D per-cell.
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

      // Draw each cell — either from per-cell texture or from atlas
      // sub-rect.
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

  // Wait briefly for any in-flight rebuild to finish so we don't
  // leak its work into the next pass.
  const waitDeadline = performance.now() + 5000
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

  const sortedD = dSamples.slice().sort((a, b) => a - b)
  const p95D = sortedD[Math.min(sortedD.length - 1, Math.floor(sortedD.length * 0.95))] ?? 0
  const meanD = dSamples.reduce((s, x) => s + x, 0) / Math.max(1, dSamples.length)
  const meanRebuildMs =
    rebuildTimes.length === 0 ? 0 : rebuildTimes.reduce((s, x) => s + x, 0) / rebuildTimes.length

  return {
    editRate,
    editsApplied,
    editsSkipped,
    rebuildsCompleted,
    meanRebuildMs,
    dSamples,
    maxD: Math.max(0, ...dSamples),
    meanD,
    p95D,
    totalFramesDecoded,
    aggregateDecodeFps: totalFramesDecoded / elapsedSec,
    jank,
    longTasks: longTaskReport,
  }
}

async function run(): Promise<void> {
  status(
    `incremental-rebuild: K=${params.k} M=${params.m} run=${params.runSeconds}s × ${params.editRates.length} rates`,
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
    const asset = await buildAtlas(source)
    if (asset === null) {
      status(`  atlas ${i} build FAILED — aborting`)
      reportResult("incremental-rebuild", params, { error: "initial atlas build failed" })
      return
    }
    atlases.push(asset)
    status(`  atlas ${i}: ${asset.width}×${asset.height} ${asset.chunks.length} chunks (${asset.buildMs.toFixed(0)}ms)`)
  }

  status(`transcoding per-cell mip ${params.cellMip.width}×${params.cellMip.height}...`)
  const perCellMip = await transcodePerCellMip(source, params.cellMip.width, params.cellMip.height)
  if (perCellMip === null) {
    status(`  per-cell mip FAILED — aborting`)
    reportResult("incremental-rebuild", params, { error: "per-cell mip transcode failed" })
    return
  }
  status(`  per-cell mip: ${perCellMip.chunks.length} chunks`)

  const results: Omit<PassResult, "dSamples">[] = []
  const dTraces: Record<string, number[]> = {}
  for (const editRate of params.editRates) {
    status(`PASS editRate=${editRate}/s`)
    const result = await runPass(source, atlases, perCellMip, editRate)
    const { dSamples, ...rest } = result
    results.push(rest)
    dTraces[`rate-${editRate}`] = dSamples
    status(
      `  fps=${(result.jank.framesObserved / params.runSeconds).toFixed(1)} ` +
        `over33=${(result.jank.over33msRatio * 100).toFixed(1)}% ` +
        `streak=${result.jank.longestJankStreak} ` +
        `meanD=${result.meanD.toFixed(2)} p95D=${result.p95D} maxD=${result.maxD} ` +
        `edits=${result.editsApplied}+${result.editsSkipped}sk ` +
        `rebuilds=${result.rebuildsCompleted}@${result.meanRebuildMs.toFixed(0)}ms`,
    )
  }
  status("done.")
  reportResult("incremental-rebuild", params, { passes: results, dTraces })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("incremental-rebuild", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
