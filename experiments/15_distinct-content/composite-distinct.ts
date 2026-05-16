// Build a sub-atlas where each cell holds a *different* source clip
// (vs harness/composite.ts which tiles ONE source into every cell).
//
// Pre-decodes each source into cell-sized ImageBitmap arrays, then
// assembles atlas frames by drawing the right bitmap into each cell.
// Sequential decode keeps peak memory bounded by output (= cell size,
// not source 1280×720 size).

import type { ProbeInput } from "../harness/input"

export interface DistinctCompositeResult {
  output: ProbeInput
  compositeMs: number
  /** Size of the encoded bitstream — entropy proxy. */
  atlasBytes: number
}

async function decodeToBitmaps(
  source: ProbeInput,
  cellWidth: number,
  cellHeight: number,
): Promise<ImageBitmap[]> {
  const canvas = new OffscreenCanvas(cellWidth, cellHeight)
  const context = canvas.getContext("2d")
  if (context === null) {
    throw new Error("decodeToBitmaps: no 2d context")
  }
  const bitmaps: ImageBitmap[] = []
  const decoder = new VideoDecoder({
    output(frame) {
      context.drawImage(frame, 0, 0, cellWidth, cellHeight)
      frame.close()
      bitmaps.push(canvas.transferToImageBitmap())
    },
    error(error) {
      throw error
    },
  })
  decoder.configure(source.config)
  for (const chunk of source.chunks) {
    decoder.decode(chunk)
  }
  await decoder.flush()
  decoder.close()
  return bitmaps
}

export async function compositeDistinct(
  sources: ProbeInput[],
  cols: number,
  rows: number,
  atlasWidth: number,
  atlasHeight: number,
): Promise<DistinctCompositeResult> {
  if (sources.length !== cols * rows) {
    throw new Error(`compositeDistinct: need ${cols * rows} sources for ${cols}×${rows} grid, got ${sources.length}`)
  }
  const start = performance.now()
  // 16-px macroblock alignment, same as harness/composite.ts.
  const snap16 = (value: number): number => Math.max(16, Math.round(value / 16) * 16)
  const width = snap16(atlasWidth)
  const height = snap16(atlasHeight)
  const cellWidth = Math.floor(width / cols)
  const cellHeight = Math.floor(height / rows)

  // Decode each source to cell-sized bitmaps. Sequential to keep
  // memory peak low.
  const perCellBitmaps: ImageBitmap[][] = []
  for (const source of sources) {
    perCellBitmaps.push(await decodeToBitmaps(source, cellWidth, cellHeight))
  }
  const frameCount = Math.min(...perCellBitmaps.map(arr => arr.length))

  const atlasCanvas = new OffscreenCanvas(width, height)
  const atlasContext = atlasCanvas.getContext("2d")
  if (atlasContext === null) {
    throw new Error("compositeDistinct: no 2d context")
  }

  const chunks: EncodedVideoChunk[] = []
  let totalBytes = 0
  let decoderConfig: VideoDecoderConfig | null = null
  const encoder = new VideoEncoder({
    output(chunk, metadata) {
      chunks.push(chunk)
      totalBytes += chunk.byteLength
      if (decoderConfig === null && metadata?.decoderConfig) {
        decoderConfig = metadata.decoderConfig
      }
    },
    error(error) {
      throw error
    },
  })
  const bitrate = Math.round(width * height * 30 * 0.1)
  encoder.configure({ codec: "vp8", width, height, bitrate, framerate: 30 })

  for (let t = 0; t < frameCount; t++) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const bitmaps = perCellBitmaps[r * cols + c]
        atlasContext.drawImage(bitmaps[t], c * cellWidth, r * cellHeight, cellWidth, cellHeight)
      }
    }
    const atlasFrame = new VideoFrame(atlasCanvas, { timestamp: t * Math.round(1_000_000 / 30) })
    encoder.encode(atlasFrame, { keyFrame: t === 0 })
    atlasFrame.close()
  }

  await encoder.flush()
  encoder.close()

  // Release the per-cell bitmaps.
  for (const arr of perCellBitmaps) {
    for (const bitmap of arr) {
      bitmap.close()
    }
  }

  if (decoderConfig === null) {
    throw new Error("compositeDistinct: encoder produced no decoder config")
  }
  if (chunks.length === 0 || chunks[0].type !== "key") {
    throw new Error("compositeDistinct: first chunk is not a keyframe")
  }
  return {
    output: {
      config: decoderConfig,
      chunks,
      width,
      height,
      requestedWidth: atlasWidth,
      requestedHeight: atlasHeight,
    },
    compositeMs: performance.now() - start,
    atlasBytes: totalBytes,
  }
}
