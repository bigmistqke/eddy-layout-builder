// upload-primitive-sweep — pure primitive cost measurement.
// Sweeps (sourceType × primitive × resolution × K-concurrent) and
// reports submitMs + finishMs per tick. No atlas, no decoder, no
// draw work.

import { wait } from "../../src/utils"
import { reportResult, status } from "../harness/report"

const params = {
  /** Per-cell measurement window. */
  cellDurationMs: 2000,
  /** Resolutions: (width, height) — snap to multiples of 16/8 for
   *  VideoFrame compatibility. Width × height roughly tracks the
   *  per-cell mip sizes used in 24-series. */
  resolutions: [
    { label: "540p", width: 960, height: 544 },
    { label: "360p", width: 640, height: 368 },
    { label: "270p", width: 480, height: 272 },
    { label: "180p", width: 320, height: 184 },
    { label: "144p", width: 256, height: 144 },
  ],
  /** Concurrent uploads per tick. */
  kValues: [1, 4, 8, 16],
}

type SourceType = "videoframe" | "uint8array"
type Primitive = "teximage2d" | "texsubimage2d"

interface CellOpts {
  sourceType: SourceType
  primitive: Primitive
  width: number
  height: number
  k: number
}

interface CellStats {
  meanMs: number
  p95Ms: number
  maxMs: number
}

interface CellResult {
  sourceType: SourceType
  primitive: Primitive
  resolution: string
  width: number
  height: number
  k: number
  sampleCount: number
  submit: CellStats
  finish: CellStats
  total: CellStats
  errors: string[]
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0
  }
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p))
  return sorted[idx]
}

function statsOf(samples: number[]): CellStats {
  const sorted = samples.slice().sort((a, b) => a - b)
  const sum = samples.reduce((a, b) => a + b, 0)
  return {
    meanMs: samples.length === 0 ? 0 : sum / samples.length,
    p95Ms: percentile(sorted, 0.95),
    maxMs: percentile(sorted, 1.0),
  }
}

async function runCell(
  gl: WebGL2RenderingContext,
  opts: CellOpts,
): Promise<CellResult> {
  const errors: string[] = []

  // Pre-generate K byte buffers (same data shape regardless of
  // source type — the videoframe variant wraps these same bytes).
  const byteSize = opts.width * opts.height * 4
  const buffers: Uint8Array[] = []
  for (let i = 0; i < opts.k; i++) {
    const buf = new Uint8Array(byteSize)
    // Cheap pseudo-random fill, deterministic per cell index.
    for (let j = 0; j < byteSize; j += 4) {
      buf[j] = (j + i * 17) & 0xff
      buf[j + 1] = (j + i * 31) & 0xff
      buf[j + 2] = (j + i * 53) & 0xff
      buf[j + 3] = 0xff
    }
    buffers.push(buf)
  }

  // Wrap as VideoFrames when needed. These VideoFrames live for the
  // duration of the cell; we close them at the end.
  const frames: VideoFrame[] = []
  if (opts.sourceType === "videoframe") {
    for (let i = 0; i < opts.k; i++) {
      try {
        const frame = new VideoFrame(buffers[i], {
          format: "RGBA",
          codedWidth: opts.width,
          codedHeight: opts.height,
          timestamp: i,
        })
        frames.push(frame)
      } catch (error) {
        errors.push(`videoframe construct: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (frames.length !== opts.k) {
      return {
        sourceType: opts.sourceType,
        primitive: opts.primitive,
        resolution: `${opts.width}x${opts.height}`,
        width: opts.width,
        height: opts.height,
        k: opts.k,
        sampleCount: 0,
        submit: statsOf([]),
        finish: statsOf([]),
        total: statsOf([]),
        errors,
      }
    }
  }

  // Pre-allocate K textures.
  const textures: WebGLTexture[] = []
  for (let i = 0; i < opts.k; i++) {
    const tex = gl.createTexture()
    if (tex === null) {
      errors.push(`createTexture ${i} failed`)
      continue
    }
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    if (opts.primitive === "texsubimage2d") {
      try {
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, opts.width, opts.height)
      } catch (error) {
        errors.push(`texStorage2D: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    textures.push(tex)
  }

  // Measurement loop. Per tick: upload K times, then finish.
  const submitSamples: number[] = []
  const finishSamples: number[] = []
  const totalSamples: number[] = []
  const deadline = performance.now() + params.cellDurationMs

  while (performance.now() < deadline) {
    const tickStart = performance.now()
    try {
      for (let i = 0; i < opts.k; i++) {
        gl.bindTexture(gl.TEXTURE_2D, textures[i])
        if (opts.primitive === "teximage2d") {
          if (opts.sourceType === "videoframe") {
            gl.texImage2D(
              gl.TEXTURE_2D,
              0,
              gl.RGBA,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              frames[i],
            )
          } else {
            gl.texImage2D(
              gl.TEXTURE_2D,
              0,
              gl.RGBA,
              opts.width,
              opts.height,
              0,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              buffers[i],
            )
          }
        } else {
          if (opts.sourceType === "videoframe") {
            gl.texSubImage2D(
              gl.TEXTURE_2D,
              0,
              0,
              0,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              frames[i],
            )
          } else {
            gl.texSubImage2D(
              gl.TEXTURE_2D,
              0,
              0,
              0,
              opts.width,
              opts.height,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              buffers[i],
            )
          }
        }
      }
    } catch (error) {
      errors.push(`upload: ${error instanceof Error ? error.message : String(error)}`)
      break
    }
    const submitEnd = performance.now()
    try {
      gl.finish()
    } catch (error) {
      errors.push(`finish: ${error instanceof Error ? error.message : String(error)}`)
      break
    }
    const finishEnd = performance.now()
    submitSamples.push(submitEnd - tickStart)
    finishSamples.push(finishEnd - submitEnd)
    totalSamples.push(finishEnd - tickStart)
    // Yield to rAF — realistic pacing, matches a render loop.
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  }

  // Clean up.
  for (const tex of textures) {
    gl.deleteTexture(tex)
  }
  for (const frame of frames) {
    try {
      frame.close()
    } catch {}
  }

  return {
    sourceType: opts.sourceType,
    primitive: opts.primitive,
    resolution: `${opts.width}x${opts.height}`,
    width: opts.width,
    height: opts.height,
    k: opts.k,
    sampleCount: submitSamples.length,
    submit: statsOf(submitSamples),
    finish: statsOf(finishSamples),
    total: statsOf(totalSamples),
    errors,
  }
}

async function run(): Promise<void> {
  status(`upload-primitive-sweep: ${params.resolutions.length} res × ${params.kValues.length} K × 2 source × 2 primitive`)

  const canvas = document.createElement("canvas")
  canvas.width = 256
  canvas.height = 256
  canvas.style.cssText =
    "position:fixed;inset:0;width:100vw;height:100vh;z-index:0;display:block;background:#000"
  document.body.appendChild(canvas)
  const glOrNull = canvas.getContext("webgl2")
  if (glOrNull === null) {
    document.body.removeChild(canvas)
    reportResult("upload-primitive-sweep", params, { error: "no webgl2 context" })
    return
  }
  const gl = glOrNull

  const sourceTypes: SourceType[] = ["videoframe", "uint8array"]
  const primitives: Primitive[] = ["teximage2d", "texsubimage2d"]
  const results: CellResult[] = []
  let cellIndex = 0
  const totalCells = sourceTypes.length * primitives.length * params.resolutions.length * params.kValues.length

  for (const sourceType of sourceTypes) {
    for (const primitive of primitives) {
      for (const resolution of params.resolutions) {
        for (const k of params.kValues) {
          cellIndex++
          status(
            `[${cellIndex}/${totalCells}] ${sourceType} ${primitive} ${resolution.label} K=${k}`,
          )
          const result = await runCell(gl, {
            sourceType,
            primitive,
            width: resolution.width,
            height: resolution.height,
            k,
          })
          results.push({ ...result, resolution: resolution.label })
          status(
            `  samples=${result.sampleCount} total mean=${result.total.meanMs.toFixed(2)}ms p95=${result.total.p95Ms.toFixed(2)}ms ` +
              `(submit=${result.submit.meanMs.toFixed(2)} finish=${result.finish.meanMs.toFixed(2)})` +
              (result.errors.length > 0 ? ` errors=${result.errors.length}` : ""),
          )
          // Small pause between cells so the GPU has time to clear.
          await wait(100)
        }
      }
    }
  }

  document.body.removeChild(canvas)
  status("done.")
  reportResult("upload-primitive-sweep", params, { cells: results })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("upload-primitive-sweep", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
