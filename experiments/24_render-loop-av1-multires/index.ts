// render-loop-av1-multires — end-to-end validation of 20d's "single
// AV1-SW pool, per-cell mip" architecture. K cells × per-K mip
// resolution × full rAF render loop with texImage2D and gl.clear.

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
  /** Each K uses the mip whose long edge matches its per-cell area. */
  passes: [
    { k: 4, gridCols: 2, gridRows: 2, mip: { label: "540p", width: 960, height: 544 } },
    { k: 9, gridCols: 3, gridRows: 3, mip: { label: "360p", width: 640, height: 368 } },
    { k: 16, gridCols: 4, gridRows: 4, mip: { label: "270p", width: 480, height: 272 } },
    { k: 25, gridCols: 5, gridRows: 5, mip: { label: "180p", width: 320, height: 184 } },
  ],
}

interface MipAsset {
  label: string
  width: number
  height: number
  config: VideoDecoderConfig
  chunks: EncodedVideoChunk[]
}

async function transcode(
  source: ProbeInput,
  mip: { label: string; width: number; height: number },
): Promise<MipAsset | null> {
  const snap16 = (value: number): number => Math.max(16, Math.round(value / 16) * 16)
  const width = snap16(mip.width)
  const height = snap16(mip.height)
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
  return { label: mip.label, width, height, config: decoderConfig, chunks }
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

interface CellSpec {
  decoderIndex: number
  ndcX: number
  ndcY: number
  ndcW: number
  ndcH: number
}

function buildGridSpecs(gridCols: number, gridRows: number): CellSpec[] {
  const cells: CellSpec[] = []
  const cellW = 2 / gridCols
  const cellH = 2 / gridRows
  for (let row = 0; row < gridRows; row++) {
    for (let col = 0; col < gridCols; col++) {
      cells.push({
        decoderIndex: row * gridCols + col,
        ndcX: -1 + col * cellW,
        ndcY: 1 - (row + 1) * cellH,
        ndcW: cellW,
        ndcH: cellH,
      })
    }
  }
  return cells
}

interface PassResult {
  k: number
  mip: string
  mipWidth: number
  mipHeight: number
  totalFramesDecoded: number
  aggregateDecodeFps: number
  jank: JankReport
  longTasks: LongTaskReport
}

async function runRenderLoop(
  asset: MipAsset,
  k: number,
  gridCols: number,
  gridRows: number,
): Promise<PassResult> {
  // Fullscreen-ish canvas matching device pixel ratio.
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

  const decoders: PacedDecoder[] = Array.from({ length: k }, () => makePacedDecoder(asset))
  const textures = decoders.map(() => {
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return tex
  })
  const cells = buildGridSpecs(gridCols, gridRows)

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
        if (cell.decoderIndex !== lastBound) {
          gl.bindTexture(gl.TEXTURE_2D, textures[cell.decoderIndex])
          lastBound = cell.decoderIndex
        }
        gl.uniform2f(uNdcOffset, cell.ndcX, cell.ndcY)
        gl.uniform2f(uNdcScale, cell.ndcW, cell.ndcH)
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
    k,
    mip: asset.label,
    mipWidth: asset.width,
    mipHeight: asset.height,
    totalFramesDecoded,
    aggregateDecodeFps: totalFramesDecoded / elapsedSec,
    jank,
    longTasks: longTaskReport,
  }
}

async function run(): Promise<void> {
  status(`render-loop-av1-multires: ${params.passes.length} K-values × ${params.runSeconds}s`)
  status(`recording VP8 source clip (${params.sourceSeconds}s)...`)
  const source = await recordProbeInput(
    params.captureResolution.width,
    params.captureResolution.height,
    params.sourceSeconds,
  )
  status(`  got ${source.width}x${source.height}, ${source.chunks.length} chunks`)

  // Transcode each unique mip once, key by label.
  const uniqueMips = new Map<string, (typeof params.passes)[number]["mip"]>()
  for (const pass of params.passes) {
    uniqueMips.set(pass.mip.label, pass.mip)
  }
  const assets = new Map<string, MipAsset>()
  for (const mip of uniqueMips.values()) {
    status(`transcoding ${mip.label} (${mip.width}×${mip.height}) AV1...`)
    const asset = await transcode(source, mip)
    if (asset === null) {
      status(`  ${mip.label} transcode FAILED — skipping`)
      continue
    }
    assets.set(mip.label, asset)
    status(`  ${mip.label}: ${asset.chunks.length} chunks`)
  }

  const results: PassResult[] = []
  for (const pass of params.passes) {
    const asset = assets.get(pass.mip.label)
    if (asset === undefined) {
      status(`SKIP K=${pass.k} — no asset for mip ${pass.mip.label}`)
      continue
    }
    status(`PASS K=${pass.k} grid=${pass.gridCols}×${pass.gridRows} mip=${pass.mip.label}`)
    const result = await runRenderLoop(asset, pass.k, pass.gridCols, pass.gridRows)
    results.push(result)
    status(
      `  fps=${(result.jank.framesObserved / params.runSeconds).toFixed(1)} ` +
        `mean=${result.jank.meanMs.toFixed(1)}ms p95=${result.jank.p95Ms.toFixed(1)}ms ` +
        `over33=${(result.jank.over33msRatio * 100).toFixed(1)}% ` +
        `streak=${result.jank.longestJankStreak} score=${result.jank.jankScore.toFixed(1)} ` +
        `decodeFps=${result.aggregateDecodeFps.toFixed(0)} ` +
        `longtasks=${result.longTasks.observed}`,
    )
  }
  status("done.")
  for (const asset of assets.values()) {
    asset.chunks.length = 0
  }
  reportResult("render-loop-av1-multires", params, { passes: results })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("render-loop-av1-multires", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
