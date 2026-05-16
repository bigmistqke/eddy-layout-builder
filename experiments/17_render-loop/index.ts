// render-loop — full production hot-path: rAF-driven WebGL render of
// N cells fed by K atlas decoders, concurrent with camera capture and
// a worker rebuilding one sub-atlas. The user-visible fps.

import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from "mediabunny"
import { wait } from "../../src/utils"
import { composite } from "../harness/composite"
import { recordProbeInput, type ProbeInput } from "../harness/input"
import { reportResult, status } from "../harness/report"

const params = {
  captureResolution: { width: 1280, height: 720 },
  // K=4 sub-atlases at CSS-pixel half of the viewport — matches 10's
  // verdict and 11's K=4 case (2x2 of 16-cell viewport).
  subAtlasResolution: { width: 270, height: 491 },
  subAtlasCols: 2,
  subAtlasRows: 2,
  // 4 sub-atlases × 4 cells = N=16 cells in a 4×4 viewport layout.
  layoutCols: 4,
  layoutRows: 4,
  // The on-screen WebGL canvas size (= 2 sub-atlases wide × 2 tall).
  canvasResolution: { width: 540, height: 982 },
  recordSeconds: 4,
  runSeconds: 4,
  maxQueue: 8,
}

interface ContinuousDecoder {
  latestFrame(): VideoFrame | null
  stop(): void
}

/** Decoder that runs in a tight loop and exposes the most recently
 *  emitted frame. Caller's renderer pulls latestFrame() per rAF. */
function makeContinuousDecoder(atlas: ProbeInput): ContinuousDecoder {
  let latest: VideoFrame | null = null
  let stopped = false
  const decoder = new VideoDecoder({
    output(frame) {
      if (latest !== null) {
        latest.close()
      }
      latest = frame
    },
    error() {},
  })
  decoder.configure(atlas.config)
  ;(async () => {
    while (!stopped) {
      for (const chunk of atlas.chunks) {
        if (stopped) {
          break
        }
        decoder.decode(chunk)
        while (decoder.decodeQueueSize > params.maxQueue && !stopped) {
          await wait(1)
        }
      }
      await decoder.flush()
      if (stopped) {
        break
      }
      decoder.reset()
      decoder.configure(atlas.config)
    }
    if (latest !== null) {
      latest.close()
      latest = null
    }
    decoder.close()
  })()
  return {
    latestFrame: () => latest,
    stop: () => {
      stopped = true
    },
  }
}

interface BuildResponse {
  compositeMs: number
  width: number
  height: number
}

function rebuildInWorker(source: ProbeInput): {
  done: Promise<BuildResponse>
  terminate(): void
} {
  const worker = new Worker(new URL("./build-worker.ts", import.meta.url), { type: "module" })
  const { promise, resolve, reject } = Promise.withResolvers<BuildResponse>()
  worker.onmessage = (event: MessageEvent<BuildResponse>) => {
    resolve(event.data)
  }
  worker.onerror = error => {
    reject(error)
  }
  worker.postMessage({
    source,
    cols: params.subAtlasCols,
    rows: params.subAtlasRows,
    width: params.subAtlasResolution.width,
    height: params.subAtlasResolution.height,
  })
  return { done: promise, terminate: () => worker.terminate() }
}

interface CaptureSample {
  frames: number
  blobBytes: number
}

async function captureForSeconds(seconds: number): Promise<CaptureSample> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: params.captureResolution.width, height: params.captureResolution.height },
    audio: true,
  })
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
  for (const track of stream.getTracks()) {
    track.stop()
  }
  const blob = new Blob(blobParts, { type: mimeType })
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  const videoTrack = await input.getPrimaryVideoTrack()
  if (videoTrack === null) {
    throw new Error("captureForSeconds: no video track")
  }
  const sink = new EncodedPacketSink(videoTrack)
  let frames = 0
  for await (const _packet of sink.packets()) {
    frames++
  }
  return { frames, blobBytes: blob.size }
}

interface CellSpec {
  atlasIndex: number
  /** UV offset/scale within the atlas (sub-rect to sample). */
  uvOffsetX: number
  uvOffsetY: number
  uvScaleX: number
  uvScaleY: number
  /** Clip-space rect to render at (NDC -1..1). */
  ndcX: number
  ndcY: number
  ndcW: number
  ndcH: number
}

function buildCellSpecs(): CellSpec[] {
  // The full layout is layoutCols × layoutRows cells (4×4 = 16 by
  // default). Each leaf-container sub-atlas covers a 2×2 region of
  // that. So sub-atlas i covers layout cells (atlasRow*2..+2,
  // atlasCol*2..+2). Each cell within a sub-atlas occupies a sub-
  // quadrant of the atlas (subAtlasCols × subAtlasRows = 2×2).
  const cells: CellSpec[] = []
  const cellW = 2 / params.layoutCols
  const cellH = 2 / params.layoutRows
  const subRowsInLayout = params.layoutRows / params.subAtlasRows
  const subColsInLayout = params.layoutCols / params.subAtlasCols
  for (let layoutRow = 0; layoutRow < params.layoutRows; layoutRow++) {
    for (let layoutCol = 0; layoutCol < params.layoutCols; layoutCol++) {
      const atlasRow = Math.floor(layoutRow / params.subAtlasRows)
      const atlasCol = Math.floor(layoutCol / params.subAtlasCols)
      const atlasIndex = atlasRow * subColsInLayout + atlasCol
      const rowInAtlas = layoutRow % params.subAtlasRows
      const colInAtlas = layoutCol % params.subAtlasCols
      cells.push({
        atlasIndex,
        uvOffsetX: colInAtlas / params.subAtlasCols,
        uvOffsetY: rowInAtlas / params.subAtlasRows,
        uvScaleX: 1 / params.subAtlasCols,
        uvScaleY: 1 / params.subAtlasRows,
        ndcX: -1 + layoutCol * cellW,
        ndcY: 1 - (layoutRow + 1) * cellH,
        ndcW: cellW,
        ndcH: cellH,
      })
    }
  }
  return cells
}

interface RenderStats {
  framesRendered: number
  renderedFps: number
  meanFrameTimeMs: number
  p95FrameTimeMs: number
  maxFrameTimeMs: number
  framesUnder16ms: number
  framesUnder33ms: number
}

function summarise(frameTimes: number[], wallSeconds: number): RenderStats {
  const sorted = frameTimes.slice().sort((a, b) => a - b)
  const sum = frameTimes.reduce((a, b) => a + b, 0)
  const p95Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))
  return {
    framesRendered: frameTimes.length,
    renderedFps: frameTimes.length / wallSeconds,
    meanFrameTimeMs: frameTimes.length === 0 ? 0 : sum / frameTimes.length,
    p95FrameTimeMs: sorted[p95Index] ?? 0,
    maxFrameTimeMs: sorted[sorted.length - 1] ?? 0,
    framesUnder16ms: frameTimes.filter(t => t <= 16).length / Math.max(1, frameTimes.length),
    framesUnder33ms: frameTimes.filter(t => t <= 33).length / Math.max(1, frameTimes.length),
  }
}

async function runRenderLoop(
  decoders: ContinuousDecoder[],
  cells: CellSpec[],
  runSeconds: number,
): Promise<RenderStats> {
  // Make the canvas live — append to body so the GL context isn't
  // an OffscreenCanvas (we want real rAF + present semantics).
  const canvas = document.createElement("canvas")
  canvas.width = params.canvasResolution.width
  canvas.height = params.canvasResolution.height
  canvas.style.cssText = "display:block;width:200px;height:auto;border:1px solid #444"
  document.body.appendChild(canvas)
  const glOrNull = canvas.getContext("webgl2")
  if (glOrNull === null) {
    throw new Error("runRenderLoop: no webgl2 context")
  }
  const gl: WebGL2RenderingContext = glOrNull

  // Shader: samples a sub-rect of a texture (uvOffset+uvScale), draws
  // a quad at an NDC rect (ndcOffset+ndcScale).
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
  // aQuad is -1..1. Map to corner in 0..1.
  vec2 corner = (aQuad + 1.0) * 0.5;
  // UV: sample the sub-rect of the atlas this cell wants.
  vUv = uUvOffset + corner * uUvScale;
  // Position: render at the cell's NDC rect (offset bottom-left in
  // [-1..1], scale in [0..2]).
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

  // One texture per atlas; texImage2D the latest VideoFrame each frame.
  const textures = decoders.map(() => {
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    return tex
  })

  const frameTimes: number[] = []
  const deadline = performance.now() + runSeconds * 1000
  const startWall = performance.now()

  await new Promise<void>(resolveLoop => {
    function tick() {
      if (performance.now() >= deadline) {
        resolveLoop()
        return
      }
      const frameStart = performance.now()
      // Upload latest atlas frames as textures
      for (let i = 0; i < decoders.length; i++) {
        const frame = decoders[i].latestFrame()
        if (frame !== null) {
          gl.bindTexture(gl.TEXTURE_2D, textures[i])
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame)
        }
      }
      // Draw each cell — bind its atlas texture + set UV / NDC uniforms.
      let lastBoundAtlas = -1
      for (const cell of cells) {
        if (cell.atlasIndex !== lastBoundAtlas) {
          gl.bindTexture(gl.TEXTURE_2D, textures[cell.atlasIndex])
          lastBoundAtlas = cell.atlasIndex
        }
        // ndcOffset = bottom-left of cell in NDC space (0..1 in the
        // shader's frame, since the vertex shader uses (aQuad+1)/2 →
        // 0..1 then * uNdcScale + uNdcOffset). The above shader hand-
        // wave reduces to: position = uNdcOffset + corner * uNdcScale.
        // Translate cell ndcX/ndcY (in -1..1 space) into that 0..1
        // origin form: origin = (ndcX + 1) / 2 in [0..1] but the
        // shader writes gl_Position with raw 0..1 — so map back:
        // We want gl_Position in -1..1; rewrite shader to use NDC
        // directly. Simpler: pass full ndc rect.
        gl.uniform2f(uNdcOffset, cell.ndcX, cell.ndcY)
        gl.uniform2f(uNdcScale, cell.ndcW, cell.ndcH)
        gl.uniform2f(uUvOffset, cell.uvOffsetX, cell.uvOffsetY)
        gl.uniform2f(uUvScale, cell.uvScaleX, cell.uvScaleY)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      }
      gl.finish()
      frameTimes.push(performance.now() - frameStart)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

  for (const tex of textures) {
    gl.deleteTexture(tex)
  }
  gl.deleteBuffer(buffer)
  gl.deleteProgram(program)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  document.body.removeChild(canvas)

  return summarise(frameTimes, (performance.now() - startWall) / 1000)
}

async function run(): Promise<void> {
  status(`recording source clip (${params.recordSeconds}s)...`)
  const source = await recordProbeInput(
    params.captureResolution.width,
    params.captureResolution.height,
    params.recordSeconds,
  )
  status(`  got ${source.width}x${source.height}, ${source.chunks.length} chunks`)

  const atlasCount = (params.layoutCols / params.subAtlasCols) * (params.layoutRows / params.subAtlasRows)
  status(`baking K=${atlasCount} sub-atlases...`)
  const atlases: ProbeInput[] = []
  for (let i = 0; i < atlasCount; i++) {
    const { output, compositeMs } = await composite(
      source,
      params.subAtlasCols,
      params.subAtlasRows,
      params.subAtlasResolution.width,
      params.subAtlasResolution.height,
    )
    atlases.push(output)
    status(`  sub-atlas ${i + 1}/${atlasCount}: ${output.width}x${output.height} (${compositeMs.toFixed(0)}ms)`)
  }

  status(`starting K=${atlasCount} continuous decoders...`)
  const decoders = atlases.map(makeContinuousDecoder)
  // Brief warm-up so each decoder has a latestFrame() ready by the
  // time the renderer starts pulling.
  await wait(200)

  const cells = buildCellSpecs()
  status(`built ${cells.length} cell specs`)

  status(`launching: render loop + capture + worker rebuild (contention)...`)
  const buildStart = performance.now()
  const build = rebuildInWorker(source)
  const [capture, render, buildResponse] = await Promise.all([
    captureForSeconds(params.runSeconds),
    runRenderLoop(decoders, cells, params.runSeconds),
    build.done,
  ])
  build.terminate()
  const buildWallClock = (performance.now() - buildStart) / 1000

  for (const decoder of decoders) {
    decoder.stop()
  }

  status(
    `  render: ${render.renderedFps.toFixed(1)}fps, mean=${render.meanFrameTimeMs.toFixed(2)}ms, ` +
      `p95=${render.p95FrameTimeMs.toFixed(2)}ms, max=${render.maxFrameTimeMs.toFixed(2)}ms, ` +
      `<16ms=${(render.framesUnder16ms * 100).toFixed(0)}%, <33ms=${(render.framesUnder33ms * 100).toFixed(0)}%`,
  )
  status(`  capture: ${capture.frames}f / ${capture.blobBytes}B`)
  status(`  rebuild: ${buildResponse.compositeMs.toFixed(0)}ms (${(buildWallClock / params.recordSeconds).toFixed(2)}× realtime)`)

  status("done.")
  reportResult("render-loop", params, {
    render,
    capture: { frames: capture.frames, bytes: capture.blobBytes },
    rebuild: {
      ms: buildResponse.compositeMs,
      wallClockSeconds: buildWallClock,
      rateVsRealtime: buildWallClock / params.recordSeconds,
    },
  })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("render-loop", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
