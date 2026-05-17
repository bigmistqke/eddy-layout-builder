// decoder-pool-time-slice — one VideoDecoder serving K cells via
// batched switches. Each cell now has its OWN recorded source (not
// the same source K times) so the per-switch cost is the REAL
// source-swap cost (reset + configure + decode-from-new-keyframe),
// not the cheaper "stay on same source" case.
//
// Theoretical limit: decoder produces ~85 fps at 720p (01). Cells
// each need 30 fps. So per decoder ≤ ~2.7 cells in pure decode-
// bandwidth terms; switch cost (~80 ms per reconfigure) eats into
// that further. Math suggests K=2 per decoder works, K=3+ fails.
// Run it and find out.

import { wait } from "../../src/utils"
import { recordProbeInput, type ProbeInput } from "../harness/input"
import { JankRecorder, observeLongTasks, type JankReport, type LongTaskReport } from "../harness/jank"
import { reportResult, status } from "../harness/report"

const params = {
  captureResolution: { width: 1280, height: 720 },
  canvasResolution: { width: 540, height: 982 },
  sourceSeconds: 6,
  runSeconds: 6,
  /** Batch size: how many frames the decoder fills into one cell's
   *  ring buffer per visit. Larger = longer to drain = fewer
   *  switches but more memory. */
  batchSize: 30,
  /** Refill threshold: cells whose buffer drops below this trigger
   *  the scheduler to switch + refill on its next visit. */
  refillThreshold: 15,
  /** Per-cell ring buffer cap (= batch size; refilled to full). */
  bufferCap: 30,
  /** K cells per pass — sweep to find where time-slicing walls. */
  cellCounts: [2, 4, 8],
  /** Source-content fps target (camera nominally 30). */
  sourceFps: 30,
}

interface Cell {
  id: number
  buffer: VideoFrame[]
  framesPaintedFromBuffer: number
  underflows: number
  lastFrameForRepaint: VideoFrame | null
  /** When the cell's playhead last advanced. Drives source-fps
   *  pacing (renderer only advances at source rate, repaints on
   *  intermediate display ticks). */
  lastAdvancedAtMs: number
}

interface SwitchEvent {
  fromCell: number
  toCell: number
  /** Time from request-switch to first frame out from the new source.
   *  This is the "pure switch cost" — reset + configure + first
   *  keyframe decode. */
  pureSwitchMs: number
  /** Total batch time: switch + all M frames + flush. */
  batchMs: number
  framesDecoded: number
}

interface PassReport {
  k: number
  switches: number
  meanPureSwitchMs: number
  maxPureSwitchMs: number
  meanBatchMs: number
  totalFramesDecoded: number
  effectiveDecoderFps: number
  perCell: Array<{
    cellId: number
    framesPainted: number
    underflows: number
    renderFps: number
  }>
  totalUnderflows: number
  jank: JankReport
}

async function runPass(sources: ProbeInput[], k: number, painter: {
  setCellLayout(k: number): void
  paintCell(cellId: number, frame: VideoFrame | null): void
}): Promise<PassReport> {
  status(`PASS K=${k}: ${k} cells, each with own source, 1 decoder, batchSize=${params.batchSize}, runSeconds=${params.runSeconds}s`)
  painter.setCellLayout(k)

  const cells: Cell[] = Array.from({ length: k }, (_, id) => ({
    id,
    buffer: [],
    framesPaintedFromBuffer: 0,
    underflows: 0,
    lastFrameForRepaint: null,
    lastAdvancedAtMs: 0,
  }))

  let activeCellId = -1
  /** Set when a new batch begins so the output handler can stamp the
   *  pureSwitchMs of the first frame of the batch. */
  let batchStartedAt = 0
  let firstFrameOfBatchSeenAt = -1
  const switches: SwitchEvent[] = []
  let totalFramesDecoded = 0
  const decoder = new VideoDecoder({
    output(frame) {
      if (firstFrameOfBatchSeenAt < 0) {
        firstFrameOfBatchSeenAt = performance.now()
      }
      if (activeCellId >= 0 && cells[activeCellId].buffer.length < params.bufferCap) {
        cells[activeCellId].buffer.push(frame)
        totalFramesDecoded++
      } else {
        // either no active cell or buffer full — drop
        frame.close()
      }
    },
    error() {},
  })

  let stop = false
  const jankRecorder = new JankRecorder()
  const passStart = performance.now()

  // Renderer: rAF runs at display rate (60 Hz). Per cell, only
  // ADVANCE the playhead at source fps (= 30 Hz default) — repaint
  // the existing frame on intermediate display ticks. This is the
  // production pacing: display refresh ≠ source rate, so the
  // renderer shouldn't drain the buffer once per display tick.
  const sourceFrameIntervalMs = 1000 / params.sourceFps
  function tick() {
    if (stop) {
      return
    }
    jankRecorder.mark()
    const now = performance.now()
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i]
      const elapsedSinceAdvance = now - cell.lastAdvancedAtMs
      const wantToAdvance = elapsedSinceAdvance >= sourceFrameIntervalMs
      if (wantToAdvance) {
        const next = cell.buffer.shift()
        if (next !== undefined) {
          if (cell.lastFrameForRepaint !== null) {
            cell.lastFrameForRepaint.close()
          }
          cell.lastFrameForRepaint = next
          cell.framesPaintedFromBuffer++
          cell.lastAdvancedAtMs = now
          painter.paintCell(i, next)
          continue
        }
        // Wanted to advance but buffer empty → underflow. Don't bump
        // lastAdvancedAtMs so the next tick tries to advance again.
        cell.underflows++
      }
      // Either not time to advance yet, or underflow — repaint the
      // existing frame.
      if (cell.lastFrameForRepaint !== null) {
        painter.paintCell(i, cell.lastFrameForRepaint)
      } else {
        painter.paintCell(i, null)
      }
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  // Scheduler: cycle through cells; for each, if buffer is below
  // threshold, switch the decoder to its source and refill with a
  // batch. Each cell has its OWN source clip → every switch pays
  // the full reset + configure + decode-from-new-keyframe cost.
  ;(async (): Promise<void> => {
    let cursor = 0
    while (!stop) {
      const cell = cells[cursor]
      const need = params.bufferCap - cell.buffer.length
      if (need >= params.bufferCap - params.refillThreshold) {
        const fromCell = activeCellId
        const cellSource = sources[cell.id]
        const switchStart = performance.now()
        firstFrameOfBatchSeenAt = -1
        if (fromCell !== cell.id) {
          decoder.reset()
          decoder.configure(cellSource.config)
        }
        activeCellId = cell.id
        const batchEnd = Math.min(params.batchSize, cellSource.chunks.length)
        for (let i = 0; i < batchEnd; i++) {
          decoder.decode(cellSource.chunks[i])
        }
        await decoder.flush()
        const elapsed = performance.now() - switchStart
        if (fromCell !== cell.id) {
          // pureSwitchMs = time from request-switch to first frame
          // of the new source emerging from the decoder.
          const pureSwitchMs =
            firstFrameOfBatchSeenAt > 0 ? firstFrameOfBatchSeenAt - switchStart : elapsed
          switches.push({
            fromCell,
            toCell: cell.id,
            pureSwitchMs,
            batchMs: elapsed,
            framesDecoded: batchEnd,
          })
        }
      }
      cursor = (cursor + 1) % k
      // Brief yield so the rAF loop and other workers run.
      await wait(0)
    }
  })()

  await wait(params.runSeconds * 1000)
  stop = true
  await wait(50)

  // Cleanup
  decoder.close()
  for (const cell of cells) {
    for (const f of cell.buffer) {
      f.close()
    }
    if (cell.lastFrameForRepaint !== null) {
      cell.lastFrameForRepaint.close()
    }
  }

  const jank = jankRecorder.snapshot()
  const meanPureSwitchMs =
    switches.length === 0 ? 0 : switches.reduce((a, s) => a + s.pureSwitchMs, 0) / switches.length
  const maxPureSwitchMs =
    switches.length === 0 ? 0 : Math.max(...switches.map(s => s.pureSwitchMs))
  const meanBatchMs =
    switches.length === 0 ? 0 : switches.reduce((a, s) => a + s.batchMs, 0) / switches.length
  return {
    k,
    switches: switches.length,
    meanPureSwitchMs,
    maxPureSwitchMs,
    meanBatchMs,
    totalFramesDecoded,
    effectiveDecoderFps: totalFramesDecoded / params.runSeconds,
    perCell: cells.map(c => ({
      cellId: c.id,
      framesPainted: c.framesPaintedFromBuffer,
      underflows: c.underflows,
      renderFps: c.framesPaintedFromBuffer / params.runSeconds,
    })),
    totalUnderflows: cells.reduce((a, c) => a + c.underflows, 0),
    jank,
  }
}

interface PainterHandle {
  setCellLayout(k: number): void
  paintCell(cellId: number, frame: VideoFrame | null): void
}

function makePainter(gl: WebGL2RenderingContext): PainterHandle {
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
  const uNdcOffset = gl.getUniformLocation(program, "uNdcOffset")!
  const uNdcScale = gl.getUniformLocation(program, "uNdcScale")!
  function makeTex(): WebGLTexture {
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return tex
  }
  const texPool: WebGLTexture[] = []
  let currentK = 0
  return {
    setCellLayout(k: number) {
      currentK = k
      while (texPool.length < k) {
        texPool.push(makeTex())
      }
      gl.clearColor(0, 0, 0, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
    },
    paintCell(cellId: number, frame: VideoFrame | null) {
      if (cellId === 0) {
        // First cell: clear at the start of each frame.
        gl.clearColor(0, 0, 0, 1)
        gl.clear(gl.COLOR_BUFFER_BIT)
      }
      if (frame === null) {
        return
      }
      const sliceH = 2 / currentK
      const ndcY = 1 - (cellId + 1) * sliceH
      gl.bindTexture(gl.TEXTURE_2D, texPool[cellId])
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame)
      gl.uniform2f(uNdcOffset, -1, ndcY)
      gl.uniform2f(uNdcScale, 2, sliceH)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    },
  }
}

async function run(): Promise<void> {
  status(`decoder-pool-time-slice: K ∈ ${JSON.stringify(params.cellCounts)}, batch=${params.batchSize}, one source per cell`)

  // Record max-K clips upfront — each cell uses a different one.
  const maxK = Math.max(...params.cellCounts)
  status(`recording ${maxK} source clips × ${params.sourceSeconds}s each...`)
  const sources: ProbeInput[] = []
  for (let i = 0; i < maxK; i++) {
    status(`  recording clip ${i + 1}/${maxK}...`)
    sources.push(
      await recordProbeInput(
        params.captureResolution.width,
        params.captureResolution.height,
        params.sourceSeconds,
      ),
    )
  }
  status(`  got ${sources.length} sources, each ${sources[0].width}x${sources[0].height}, ~${sources[0].chunks.length} chunks`)

  const canvas = document.createElement("canvas")
  canvas.width = params.canvasResolution.width
  canvas.height = params.canvasResolution.height
  document.body.appendChild(canvas)
  const glOrNull = canvas.getContext("webgl2")
  if (glOrNull === null) {
    throw new Error("no webgl2")
  }
  const gl: WebGL2RenderingContext = glOrNull
  const painter = makePainter(gl)

  const longtaskObserver = observeLongTasks()
  const passes: PassReport[] = []
  for (const k of params.cellCounts) {
    const passSources = sources.slice(0, k)
    const report = await runPass(passSources, k, painter)
    passes.push(report)
    const perCellSummary = report.perCell
      .map(c => `cell${c.cellId}=${c.renderFps.toFixed(1)}fps/${c.underflows}u`)
      .join(", ")
    status(
      `  K=${k}: decoder=${report.effectiveDecoderFps.toFixed(1)}fps switches=${report.switches} ` +
        `pureSwitch mean=${report.meanPureSwitchMs.toFixed(1)}ms max=${report.maxPureSwitchMs.toFixed(1)}ms batch=${report.meanBatchMs.toFixed(1)}ms; ` +
        `perCell: ${perCellSummary}; totalUnderflows=${report.totalUnderflows}; ` +
        `jank score=${report.jank.jankScore.toFixed(1)} max=${report.jank.maxMs.toFixed(0)}ms`,
    )
  }
  const longtasks = longtaskObserver.stop()
  document.body.removeChild(canvas)
  status("done.")
  reportResult("decoder-pool-time-slice", params, {
    passes,
    longtasks: longtasks satisfies LongTaskReport,
  })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("decoder-pool-time-slice", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
