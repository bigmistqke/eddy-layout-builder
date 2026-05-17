// rebuild-during-record — 4 isolating passes that pile capture +
// rebuild onto a K=16 M=2 atlas playback baseline, to attribute jank
// to each concurrent workload. Models the single load-bearing moment
// in the refined eventually-consistent design: one rebuild + one
// camera capture concurrent with steady-state playback.

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
  /** Per-pass run length; long enough for rebuild + capture to complete. */
  runSeconds: 15,
  /** Rebuild fires at T+rebuildStartMs once the render loop is rolling. */
  rebuildStartMs: 2000,
  /** Capture duration when a pass uses capture. */
  captureSeconds: 10,
  bitratePerPixel: 0.1,
  swCodec: { label: "av1", codecString: "av01.0.04M.08" },
  k: 16,
  m: 2,
  /** 2×4 cells per atlas = 8 cells × 270p mip → 960×1088 atlas. */
  atlasCols: 2,
  atlasRows: 4,
  gridCols: 4,
  gridRows: 4,
  cellMip: { width: 480, height: 272 },
  /** Rebuild produces a small 4-cell atlas (the "4 newly-batched
   *  dirty cells" of the refined design). */
  rebuildAtlasCols: 2,
  rebuildAtlasRows: 2,
  passes: [
    { label: "baseline", capture: false, rebuild: false },
    { label: "capture-only", capture: true, rebuild: false },
    { label: "rebuild-only", capture: false, rebuild: true },
    { label: "full", capture: true, rebuild: true },
  ],
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

interface RebuildWorker {
  build(): Promise<{ buildMs: number; ok: boolean }>
  terminate(): void
}

async function createRebuildWorker(source: ProbeInput): Promise<RebuildWorker> {
  // Reuse 24d's worker (lives in this directory's sibling).
  const worker = new Worker(
    new URL("../24d_worker-rebuild/rebuild-worker.ts", import.meta.url),
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
    async build(): Promise<{ buildMs: number; ok: boolean }> {
      const jobId = nextJobId++
      const { promise, resolve } = Promise.withResolvers<{ buildMs: number; ok: boolean }>()
      const handler = (event: MessageEvent<{ type: string; jobId: number; ok: boolean; buildMs: number }>) => {
        if (event.data.type !== "done" || event.data.jobId !== jobId) {
          return
        }
        worker.removeEventListener("message", handler)
        resolve({ buildMs: event.data.buildMs, ok: event.data.ok })
      }
      worker.addEventListener("message", handler)
      worker.postMessage({
        type: "build",
        jobId,
        atlasCols: params.rebuildAtlasCols,
        atlasRows: params.rebuildAtlasRows,
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

async function buildAtlasInline(source: ProbeInput): Promise<AtlasAsset | null> {
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
  label: string
  captureEnabled: boolean
  rebuildEnabled: boolean
  totalFramesDecoded: number
  aggregateDecodeFps: number
  rebuildBuildMs: number | null
  rebuildOk: boolean | null
  captureCompleted: boolean
  captureFrameCount: number | null
  jank: JankReport
  longTasks: LongTaskReport
}

async function runPass(
  source: ProbeInput,
  atlases: AtlasAsset[],
  pass: (typeof params.passes)[number],
  rebuildWorker: RebuildWorker | null,
): Promise<PassResult> {
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

  // Cell layout: K cells in gridCols × gridRows viewport, distributed
  // across M atlases (round-robin into atlasCols × atlasRows tiles).
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
  const atlasDecoders: PacedDecoder[] = atlases.map(makePacedDecoder)
  const atlasTextures = atlases.map(() => {
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return tex
  })

  // Capture promise (fire-and-forget; we only care about whether it
  // completes and how many chunks it produced).
  let captureCompleted = false
  let captureFrameCount: number | null = null
  let capturePromise: Promise<void> | null = null
  if (pass.capture) {
    capturePromise = recordProbeInput(
      params.captureResolution.width,
      params.captureResolution.height,
      params.captureSeconds,
    )
      .then(probe => {
        captureFrameCount = probe.chunks.length
        captureCompleted = true
      })
      .catch(() => {
        captureCompleted = false
      })
  }

  // Rebuild promise — fires at T+rebuildStartMs.
  let rebuildBuildMs: number | null = null
  let rebuildOk: boolean | null = null
  let rebuildPromise: Promise<void> | null = null

  const recorder = new JankRecorder()
  const longTasks = observeLongTasks()
  const deadline = performance.now() + params.runSeconds * 1000
  const startWall = performance.now()
  const targetFps = 30
  let rebuildFired = false

  await new Promise<void>(resolveLoop => {
    function tick(now: number) {
      if (now >= deadline) {
        resolveLoop()
        return
      }
      recorder.mark(now)
      const elapsedMs = now - startWall

      if (
        pass.rebuild &&
        !rebuildFired &&
        elapsedMs >= params.rebuildStartMs &&
        rebuildWorker !== null
      ) {
        rebuildFired = true
        rebuildPromise = rebuildWorker.build().then(r => {
          rebuildBuildMs = r.buildMs
          rebuildOk = r.ok
        })
      }

      for (const decoder of atlasDecoders) {
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
      const viewportCellW = 2 / params.gridCols
      const viewportCellH = 2 / params.gridRows
      let lastBound = -1
      for (let i = 0; i < params.k; i++) {
        const row = Math.floor(i / params.gridCols)
        const col = i % params.gridCols
        const ndcX = -1 + col * viewportCellW
        const ndcY = 1 - (row + 1) * viewportCellH
        const atlasIdx = cellAtlas[i]
        if (atlasIdx !== lastBound) {
          gl.bindTexture(gl.TEXTURE_2D, atlasTextures[atlasIdx])
          lastBound = atlasIdx
        }
        const slot = cellSlotInAtlas[i]
        const tileRow = Math.floor(slot / params.atlasCols)
        const tileCol = slot % params.atlasCols
        gl.uniform2f(uUvOffset, tileCol / params.atlasCols, 1 - (tileRow + 1) / params.atlasRows)
        gl.uniform2f(uUvScale, 1 / params.atlasCols, 1 / params.atlasRows)
        gl.uniform2f(uNdcOffset, ndcX, ndcY)
        gl.uniform2f(uNdcScale, viewportCellW, viewportCellH)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

  // Wait briefly for any pending background tasks to finish reporting.
  if (capturePromise !== null) {
    await Promise.race([capturePromise, wait(5000)])
  }
  if (rebuildPromise !== null) {
    await Promise.race([rebuildPromise, wait(15000)])
  }

  const longTaskReport = longTasks.stop()
  const jank = recorder.snapshot()
  const elapsedSec = (performance.now() - startWall) / 1000
  const totalFramesDecoded = atlasDecoders.reduce((s, d) => s + d.framesDecoded(), 0)

  for (const decoder of atlasDecoders) {
    decoder.stop()
  }
  for (const tex of atlasTextures) {
    gl.deleteTexture(tex)
  }
  gl.deleteBuffer(buffer)
  gl.deleteProgram(program)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  document.body.removeChild(canvas)

  return {
    label: pass.label,
    captureEnabled: pass.capture,
    rebuildEnabled: pass.rebuild,
    totalFramesDecoded,
    aggregateDecodeFps: totalFramesDecoded / elapsedSec,
    rebuildBuildMs,
    rebuildOk,
    captureCompleted,
    captureFrameCount,
    jank,
    longTasks: longTaskReport,
  }
}

async function run(): Promise<void> {
  status(`rebuild-during-record: K=${params.k} M=${params.m}, ${params.passes.length} passes × ${params.runSeconds}s`)
  status(`recording source clip (${params.sourceSeconds}s)...`)
  const source = await recordProbeInput(
    params.captureResolution.width,
    params.captureResolution.height,
    params.sourceSeconds,
  )
  status(`  got ${source.width}x${source.height}, ${source.chunks.length} chunks`)

  status(`building ${params.m} initial AV1 atlases (${params.atlasCols}×${params.atlasRows} cells)...`)
  const atlases: AtlasAsset[] = []
  for (let i = 0; i < params.m; i++) {
    const asset = await buildAtlasInline(source)
    if (asset === null) {
      status(`  atlas ${i} build FAILED — aborting`)
      reportResult("rebuild-during-record", params, { error: "initial atlas build failed" })
      return
    }
    atlases.push(asset)
    status(`  atlas ${i}: ${asset.width}×${asset.height} ${asset.chunks.length} chunks (${asset.buildMs.toFixed(0)}ms)`)
  }

  // One shared rebuild worker, re-used across passes.
  const rebuildWorker = await createRebuildWorker(source)

  const results: PassResult[] = []
  for (const pass of params.passes) {
    status(`PASS [${pass.label}] capture=${pass.capture} rebuild=${pass.rebuild}`)
    const result = await runPass(source, atlases, pass, rebuildWorker)
    results.push(result)
    status(
      `  fps=${(result.jank.framesObserved / params.runSeconds).toFixed(1)} ` +
        `mean=${result.jank.meanMs.toFixed(1)}ms p95=${result.jank.p95Ms.toFixed(1)}ms ` +
        `over33=${(result.jank.over33msRatio * 100).toFixed(1)}% ` +
        `streak=${result.jank.longestJankStreak} score=${result.jank.jankScore.toFixed(1)} ` +
        `decodeFps=${result.aggregateDecodeFps.toFixed(0)} ` +
        `rebuild=${result.rebuildBuildMs === null ? "n/a" : result.rebuildBuildMs.toFixed(0) + "ms (ok=" + result.rebuildOk + ")"} ` +
        `capture=${result.captureEnabled ? (result.captureCompleted ? "ok, " + result.captureFrameCount + " chunks" : "failed") : "n/a"} ` +
        `longtasks=${result.longTasks.observed}`,
    )
    // Brief pause to let device cool / IPC settle between passes.
    await wait(2000)
  }
  rebuildWorker.terminate()
  status("done.")
  reportResult("rebuild-during-record", params, { passes: results })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("rebuild-during-record", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
