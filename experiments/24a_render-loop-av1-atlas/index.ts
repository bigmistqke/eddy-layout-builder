// render-loop-av1-atlas — M AV1-SW atlas decoders, K cells sampling
// sub-rects. Direct comparison against 24's per-cell architecture
// at K=9/16/25.

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
  runSeconds: 10,
  bitratePerPixel: 0.1,
  swCodec: { label: "av1", codecString: "av01.0.04M.08" },
  /** Each pass: K cells split across M sub-atlases. Each sub-atlas
   *  tiles `atlasCols × atlasRows` cells at the given per-cell mip. */
  passes: [
    {
      k: 9,
      m: 1,
      atlasCols: 3,
      atlasRows: 3,
      gridCols: 3,
      gridRows: 3,
      cellMip: { width: 480, height: 272 },
      label: "K9-M1",
    },
    {
      k: 16,
      m: 4,
      atlasCols: 2,
      atlasRows: 2,
      gridCols: 4,
      gridRows: 4,
      cellMip: { width: 480, height: 272 },
      label: "K16-M4",
    },
    {
      k: 25,
      m: 5,
      atlasCols: 5,
      atlasRows: 1,
      gridCols: 5,
      gridRows: 5,
      cellMip: { width: 320, height: 184 },
      label: "K25-M5",
    },
  ],
}

interface AtlasAsset {
  label: string
  atlasCols: number
  atlasRows: number
  cellWidth: number
  cellHeight: number
  width: number
  height: number
  config: VideoDecoderConfig
  chunks: EncodedVideoChunk[]
  buildMs: number
}

/** Build one AV1 atlas: tile cellCols × cellRows of source content. */
async function buildAtlas(
  source: ProbeInput,
  label: string,
  cellCols: number,
  cellRows: number,
  cellMipW: number,
  cellMipH: number,
): Promise<AtlasAsset | null> {
  const start = performance.now()
  const snap16 = (value: number): number => Math.max(16, Math.round(value / 16) * 16)
  const cellWidth = snap16(cellMipW)
  const cellHeight = snap16(cellMipH)
  const width = cellWidth * cellCols
  const height = cellHeight * cellRows
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
        for (let row = 0; row < cellRows; row++) {
          for (let col = 0; col < cellCols; col++) {
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
    label,
    atlasCols: cellCols,
    atlasRows: cellRows,
    cellWidth,
    cellHeight,
    width,
    height,
    config: decoderConfig,
    chunks,
    buildMs: performance.now() - start,
  }
}

interface PacedAtlasDecoder {
  latestFrame(): VideoFrame | null
  feedTo(elapsedMs: number, targetFps: number): void
  framesDecoded(): number
  stop(): void
}

function makePacedDecoder(asset: AtlasAsset): PacedAtlasDecoder {
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

interface CellSpec {
  atlasIndex: number
  ndcX: number
  ndcY: number
  ndcW: number
  ndcH: number
  uvOffsetX: number
  uvOffsetY: number
  uvScaleX: number
  uvScaleY: number
}

/** Build cell specs: K cells in a gridCols × gridRows viewport
 *  layout, distributed round-robin across M atlases. Within each
 *  atlas the assigned cells fill atlasCols × atlasRows tiles. */
function buildCellSpecs(
  k: number,
  gridCols: number,
  gridRows: number,
  m: number,
  atlasCols: number,
  atlasRows: number,
): CellSpec[] {
  const cells: CellSpec[] = []
  const viewportCellW = 2 / gridCols
  const viewportCellH = 2 / gridRows
  const atlasCellsPerAtlas = atlasCols * atlasRows
  const perAtlasCounts = new Array<number>(m).fill(0)
  for (let i = 0; i < k; i++) {
    const row = Math.floor(i / gridCols)
    const col = i % gridCols
    const atlasIndex = i % m
    const slotInAtlas = perAtlasCounts[atlasIndex]++
    if (slotInAtlas >= atlasCellsPerAtlas) {
      throw new Error(
        `cell ${i} → atlas ${atlasIndex} slot ${slotInAtlas} exceeds atlas capacity ${atlasCellsPerAtlas}`,
      )
    }
    const tileRow = Math.floor(slotInAtlas / atlasCols)
    const tileCol = slotInAtlas % atlasCols
    cells.push({
      atlasIndex,
      ndcX: -1 + col * viewportCellW,
      ndcY: 1 - (row + 1) * viewportCellH,
      ndcW: viewportCellW,
      ndcH: viewportCellH,
      uvOffsetX: tileCol / atlasCols,
      uvOffsetY: 1 - (tileRow + 1) / atlasRows,
      uvScaleX: 1 / atlasCols,
      uvScaleY: 1 / atlasRows,
    })
  }
  return cells
}

interface PassResult {
  label: string
  k: number
  m: number
  atlasCols: number
  atlasRows: number
  atlasWidth: number
  atlasHeight: number
  atlasBuildMsMean: number
  totalFramesDecoded: number
  aggregateDecodeFps: number
  jank: JankReport
  longTasks: LongTaskReport
}

async function runRenderLoop(
  atlases: AtlasAsset[],
  cells: CellSpec[],
): Promise<{
  totalFramesDecoded: number
  aggregateDecodeFps: number
  jank: JankReport
  longTasks: LongTaskReport
}> {
  const canvas = document.createElement("canvas")
  canvas.width = window.innerWidth * (window.devicePixelRatio || 1)
  canvas.height = window.innerHeight * (window.devicePixelRatio || 1)
  canvas.style.cssText =
    "position:fixed;inset:0;width:100vw;height:100vh;z-index:0;display:block"
  document.body.appendChild(canvas)
  const glOrNull = canvas.getContext("webgl2")
  if (glOrNull === null) {
    document.body.removeChild(canvas)
    throw new Error("runRenderLoop: no webgl2 context")
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

  const decoders = atlases.map(makePacedDecoder)
  const textures = atlases.map(() => {
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return tex
  })

  const recorder = new JankRecorder()
  const longTasks = observeLongTasks()
  const deadline = performance.now() + params.runSeconds * 1000
  const startWall = performance.now()
  const targetFps = 30

  gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)

  await new Promise<void>(resolveLoop => {
    function tick(now: number) {
      if (now >= deadline) {
        resolveLoop()
        return
      }
      recorder.mark(now)
      const elapsedMs = now - startWall
      for (const decoder of decoders) {
        decoder.feedTo(elapsedMs, targetFps)
      }
      gl.clear(gl.COLOR_BUFFER_BIT)
      for (let i = 0; i < decoders.length; i++) {
        const frame = decoders[i].latestFrame()
        if (frame === null) {
          continue
        }
        gl.bindTexture(gl.TEXTURE_2D, textures[i])
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame)
      }
      let lastBound = -1
      for (const cell of cells) {
        if (cell.atlasIndex !== lastBound) {
          gl.bindTexture(gl.TEXTURE_2D, textures[cell.atlasIndex])
          lastBound = cell.atlasIndex
        }
        gl.uniform2f(uNdcOffset, cell.ndcX, cell.ndcY)
        gl.uniform2f(uNdcScale, cell.ndcW, cell.ndcH)
        gl.uniform2f(uUvOffset, cell.uvOffsetX, cell.uvOffsetY)
        gl.uniform2f(uUvScale, cell.uvScaleX, cell.uvScaleY)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

  const longTaskReport = longTasks.stop()
  const jank = recorder.snapshot()
  const totalFramesDecoded = decoders.reduce((s, d) => s + d.framesDecoded(), 0)
  const elapsedSec = (performance.now() - startWall) / 1000

  for (const decoder of decoders) {
    decoder.stop()
  }
  for (const tex of textures) {
    gl.deleteTexture(tex)
  }
  gl.deleteBuffer(buffer)
  gl.deleteProgram(program)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  document.body.removeChild(canvas)

  return {
    totalFramesDecoded,
    aggregateDecodeFps: totalFramesDecoded / elapsedSec,
    jank,
    longTasks: longTaskReport,
  }
}

async function run(): Promise<void> {
  status(`render-loop-av1-atlas: ${params.passes.length} K-values × ${params.runSeconds}s`)
  status(`recording VP8 source clip (${params.sourceSeconds}s)...`)
  const source = await recordProbeInput(
    params.captureResolution.width,
    params.captureResolution.height,
    params.sourceSeconds,
  )
  status(`  got ${source.width}x${source.height}, ${source.chunks.length} chunks`)

  const results: PassResult[] = []
  for (const pass of params.passes) {
    status(
      `PASS [${pass.label}] K=${pass.k} M=${pass.m} atlas=${pass.atlasCols}×${pass.atlasRows} mip=${pass.cellMip.width}×${pass.cellMip.height}`,
    )
    status(`  building ${pass.m} atlases...`)
    const atlases: AtlasAsset[] = []
    let atlasBuildOk = true
    for (let i = 0; i < pass.m; i++) {
      const asset = await buildAtlas(
        source,
        `${pass.label}-atlas${i}`,
        pass.atlasCols,
        pass.atlasRows,
        pass.cellMip.width,
        pass.cellMip.height,
      )
      if (asset === null) {
        status(`  atlas ${i} build FAILED — skipping pass`)
        atlasBuildOk = false
        break
      }
      atlases.push(asset)
      status(`    atlas ${i}: ${asset.width}×${asset.height} ${asset.chunks.length} chunks (${asset.buildMs.toFixed(0)}ms)`)
    }
    if (!atlasBuildOk) {
      continue
    }
    const cells = buildCellSpecs(
      pass.k,
      pass.gridCols,
      pass.gridRows,
      pass.m,
      pass.atlasCols,
      pass.atlasRows,
    )
    const loopResult = await runRenderLoop(atlases, cells)
    const atlasBuildMsMean = atlases.reduce((s, a) => s + a.buildMs, 0) / atlases.length
    results.push({
      label: pass.label,
      k: pass.k,
      m: pass.m,
      atlasCols: pass.atlasCols,
      atlasRows: pass.atlasRows,
      atlasWidth: atlases[0].width,
      atlasHeight: atlases[0].height,
      atlasBuildMsMean,
      ...loopResult,
    })
    status(
      `  fps=${(loopResult.jank.framesObserved / params.runSeconds).toFixed(1)} ` +
        `mean=${loopResult.jank.meanMs.toFixed(1)}ms p95=${loopResult.jank.p95Ms.toFixed(1)}ms ` +
        `over33=${(loopResult.jank.over33msRatio * 100).toFixed(1)}% ` +
        `streak=${loopResult.jank.longestJankStreak} score=${loopResult.jank.jankScore.toFixed(1)} ` +
        `decodeFps=${loopResult.aggregateDecodeFps.toFixed(0)} ` +
        `longtasks=${loopResult.longTasks.observed}`,
    )
    // Free chunks before next pass.
    for (const atlas of atlases) {
      atlas.chunks.length = 0
    }
  }
  status("done.")
  reportResult("render-loop-av1-atlas", params, { passes: results })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("render-loop-av1-atlas", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
