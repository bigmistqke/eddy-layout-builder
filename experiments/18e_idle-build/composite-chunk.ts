// Build an atlas covering a FRAME RANGE of N source clips. Pre-decode
// each source once into cell-sized bitmaps (so VP8-keyframe-at-
// arbitrary-frame isn't a problem — we re-encode atlas frames from
// pre-decoded bitmaps, not from re-decoding source chunks per chunk).
//
// Same shape as 15's compositeDistinct, but accepts (frameStart,
// frameEnd) so it can build a temporal chunk of the atlas. The
// pre-decode is shared: factory returns a builder that re-uses the
// decoded bitmaps across multiple chunk-builds of the same sources.

import type { ProbeInput } from "../harness/input"

export interface ChunkAtlas {
  output: ProbeInput
  compositeMs: number
  atlasBytes: number
  frameStart: number
  frameEnd: number
}

export interface ChunkComposer {
  /** Build one chunk covering frames [frameStart, frameEnd). */
  buildChunk(frameStart: number, frameEnd: number): Promise<ChunkAtlas>
  /** Total source frames available (min across sources). */
  totalFrames(): number
  /** Release all the pre-decoded bitmaps. */
  dispose(): void
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

export async function createChunkComposer(
  sources: ProbeInput[],
  cols: number,
  rows: number,
  atlasWidth: number,
  atlasHeight: number,
): Promise<ChunkComposer> {
  if (sources.length !== cols * rows) {
    throw new Error(`createChunkComposer: need ${cols * rows} sources, got ${sources.length}`)
  }
  const snap16 = (value: number): number => Math.max(16, Math.round(value / 16) * 16)
  const width = snap16(atlasWidth)
  const height = snap16(atlasHeight)
  const cellWidth = Math.floor(width / cols)
  const cellHeight = Math.floor(height / rows)

  const perCellBitmaps: ImageBitmap[][] = []
  for (const source of sources) {
    perCellBitmaps.push(await decodeToBitmaps(source, cellWidth, cellHeight))
  }
  const minFrames = Math.min(...perCellBitmaps.map(arr => arr.length))

  const atlasCanvas = new OffscreenCanvas(width, height)
  const atlasContext = atlasCanvas.getContext("2d")
  if (atlasContext === null) {
    throw new Error("createChunkComposer: no 2d context")
  }

  return {
    totalFrames: () => minFrames,
    async buildChunk(frameStart: number, frameEnd: number): Promise<ChunkAtlas> {
      const start = performance.now()
      const clampedStart = Math.max(0, Math.min(minFrames, frameStart))
      const clampedEnd = Math.max(clampedStart, Math.min(minFrames, frameEnd))

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

      for (let t = clampedStart; t < clampedEnd; t++) {
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const bitmaps = perCellBitmaps[r * cols + c]
            atlasContext.drawImage(bitmaps[t], c * cellWidth, r * cellHeight, cellWidth, cellHeight)
          }
        }
        const atlasFrame = new VideoFrame(atlasCanvas, {
          timestamp: (t - clampedStart) * Math.round(1_000_000 / 30),
        })
        encoder.encode(atlasFrame, { keyFrame: t === clampedStart })
        atlasFrame.close()
      }
      await encoder.flush()
      encoder.close()

      if (decoderConfig === null) {
        throw new Error("buildChunk: no decoder config")
      }
      if (chunks.length === 0 || chunks[0].type !== "key") {
        throw new Error("buildChunk: first chunk not a keyframe")
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
        frameStart: clampedStart,
        frameEnd: clampedEnd,
      }
    },
    dispose() {
      for (const arr of perCellBitmaps) {
        for (const bitmap of arr) {
          bitmap.close()
        }
      }
    },
  }
}
