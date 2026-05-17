// session-save-encode — measures encode wall time for raw RGBA → AV1
// and VP9 across K cells. Sequential vs parallel modes show whether
// the codec service serialises concurrent encoders.

import { wait } from "../../src/utils"
import { recordProbeInput, type ProbeInput } from "../harness/input"
import { reportResult, status } from "../harness/report"

const params = {
  captureResolution: { width: 1280, height: 720 },
  sourceSeconds: 6,
  framesPerCell: 60,
  bitratePerPixel: 0.1,
  codecs: [
    { label: "av1", codecString: "av01.0.04M.08" },
    { label: "vp9", codecString: "vp09.00.10.08" },
  ],
  passes: [
    { k: 4, mip: { label: "540p", width: 960, height: 544 } },
    { k: 9, mip: { label: "360p", width: 640, height: 368 } },
    { k: 16, mip: { label: "270p", width: 480, height: 272 } },
    { k: 25, mip: { label: "180p", width: 320, height: 184 } },
  ],
}

const snap16 = (value: number): number => Math.max(16, Math.round(value / 16) * 16)

interface RgbaStream {
  width: number
  height: number
  frames: Uint8Array[]
}

async function decodeToRgba(
  source: ProbeInput,
  targetW: number,
  targetH: number,
  maxFrames: number,
): Promise<RgbaStream | null> {
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

interface EncodeResult {
  ok: boolean
  encodeMs: number
  outputBytes: number
  frameCount: number
  errors: string[]
}

async function encodeCell(
  rgbaFrames: Uint8Array[],
  width: number,
  height: number,
  codecString: string,
): Promise<EncodeResult> {
  const start = performance.now()
  const errors: string[] = []
  let outputBytes = 0
  const bitrate = Math.round(width * height * 30 * params.bitratePerPixel)
  const encoder = new VideoEncoder({
    output(chunk) {
      outputBytes += chunk.byteLength
    },
    error(error) {
      errors.push(`enc: ${error.message}`)
    },
  })
  try {
    encoder.configure({
      codec: codecString,
      width,
      height,
      bitrate,
      framerate: 30,
    })
  } catch (error) {
    encoder.close()
    return {
      ok: false,
      encodeMs: performance.now() - start,
      outputBytes: 0,
      frameCount: 0,
      errors: [`configure: ${error instanceof Error ? error.message : String(error)}`],
    }
  }
  for (let i = 0; i < rgbaFrames.length; i++) {
    const frame = new VideoFrame(rgbaFrames[i], {
      format: "RGBA",
      codedWidth: width,
      codedHeight: height,
      timestamp: i * 33333,
    })
    try {
      encoder.encode(frame, { keyFrame: i === 0 })
    } catch (error) {
      errors.push(`encode: ${error instanceof Error ? error.message : String(error)}`)
    }
    frame.close()
  }
  try {
    await encoder.flush()
  } catch (error) {
    errors.push(`flush: ${error instanceof Error ? error.message : String(error)}`)
  }
  encoder.close()
  return {
    ok: errors.length === 0,
    encodeMs: performance.now() - start,
    outputBytes,
    frameCount: rgbaFrames.length,
    errors,
  }
}

interface ModeResult {
  mode: "sequential" | "parallel"
  totalMs: number
  perCell: EncodeResult[]
  bytesPerCell: number
  totalBytesKb: number
}

interface CodecResult {
  codec: string
  sequential: ModeResult
  parallel: ModeResult
}

interface PassResult {
  k: number
  mip: string
  mipWidth: number
  mipHeight: number
  rgbaBytesPerCell: number
  codecs: CodecResult[]
}

async function runEncodeMode(
  mode: "sequential" | "parallel",
  rgbaFrames: Uint8Array[],
  k: number,
  width: number,
  height: number,
  codecString: string,
): Promise<ModeResult> {
  const start = performance.now()
  const perCell: EncodeResult[] = []
  if (mode === "sequential") {
    for (let i = 0; i < k; i++) {
      const r = await encodeCell(rgbaFrames, width, height, codecString)
      perCell.push(r)
    }
  } else {
    const all = await Promise.all(
      Array.from({ length: k }, () => encodeCell(rgbaFrames, width, height, codecString)),
    )
    for (const r of all) {
      perCell.push(r)
    }
  }
  const totalMs = performance.now() - start
  const totalBytes = perCell.reduce((s, c) => s + c.outputBytes, 0)
  const bytesPerCell = perCell.length > 0 ? totalBytes / perCell.length : 0
  return {
    mode,
    totalMs,
    perCell,
    bytesPerCell,
    totalBytesKb: totalBytes / 1024,
  }
}

async function run(): Promise<void> {
  status(`session-save-encode: ${params.passes.length} K-values × ${params.codecs.length} codecs × 2 modes`)
  status(`recording source clip (${params.sourceSeconds}s)...`)
  const source = await recordProbeInput(
    params.captureResolution.width,
    params.captureResolution.height,
    params.sourceSeconds,
  )
  status(`  got ${source.width}x${source.height}, ${source.chunks.length} chunks`)

  const results: PassResult[] = []
  for (const pass of params.passes) {
    status(`PASS K=${pass.k} mip=${pass.mip.label}`)
    const stream = await decodeToRgba(source, pass.mip.width, pass.mip.height, params.framesPerCell)
    if (stream === null) {
      status(`  decode FAILED — skipping`)
      continue
    }
    const rgbaBytesPerCell = stream.frames.reduce((s, f) => s + f.byteLength, 0)
    status(
      `  decoded ${stream.frames.length} frames, ${(rgbaBytesPerCell / 1024 / 1024).toFixed(1)} MB per cell`,
    )

    const codecResults: CodecResult[] = []
    for (const codec of params.codecs) {
      status(`  CODEC=${codec.label}`)
      const sequential = await runEncodeMode(
        "sequential",
        stream.frames,
        pass.k,
        stream.width,
        stream.height,
        codec.codecString,
      )
      status(
        `    sequential: ${sequential.totalMs.toFixed(0)}ms total, ${(sequential.bytesPerCell / 1024).toFixed(1)} KB/cell`,
      )
      const parallel = await runEncodeMode(
        "parallel",
        stream.frames,
        pass.k,
        stream.width,
        stream.height,
        codec.codecString,
      )
      status(
        `    parallel:   ${parallel.totalMs.toFixed(0)}ms total, ${(parallel.bytesPerCell / 1024).toFixed(1)} KB/cell`,
      )
      codecResults.push({ codec: codec.label, sequential, parallel })
      await wait(500)
    }

    results.push({
      k: pass.k,
      mip: pass.mip.label,
      mipWidth: stream.width,
      mipHeight: stream.height,
      rgbaBytesPerCell,
      codecs: codecResults,
    })

    // Free this pass's RGBA frames.
    stream.frames.length = 0
  }
  status("done.")
  reportResult("session-save-encode", params, { passes: results })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("session-save-encode", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
