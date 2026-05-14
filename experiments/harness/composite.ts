import type { ProbeInput } from "./input"

// Build an atlas video: tile `source` into a cols×rows grid filling one
// atlas frame, re-encoded as a single stream. This models the composite
// playback representation — N cells carried by ONE decode, regardless of
// N — so it can be measured head-to-head against N independent streams.
//
// Like harness/transcode.ts, this goes through WebCodecs VideoEncoder,
// so it carries the same "re-encode decode tax" — which is the point:
// the composite must be judged under the same tax as streaming.

export interface CompositeResult {
  /** The atlas clip, shaped like a ProbeInput — ready to decode. */
  output: ProbeInput
  /** Wall-clock ms to build the atlas (decode → tile → re-encode). */
  compositeMs: number
}

export async function composite(
  source: ProbeInput,
  cols: number,
  rows: number,
  atlasWidth: number,
  atlasHeight: number,
): Promise<CompositeResult> {
  const start = performance.now()
  // VP8 encodes in 16×16 macroblocks — snap the atlas to multiples of 16
  // so the encoder doesn't pad (padding decodes slower; see transcode.ts).
  const snap16 = (value: number): number => Math.max(16, Math.round(value / 16) * 16)
  const width = snap16(atlasWidth)
  const height = snap16(atlasHeight)
  const cellWidth = Math.floor(width / cols)
  const cellHeight = Math.floor(height / rows)
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext("2d")
  if (context === null) {
    throw new Error("composite: no 2d context")
  }

  const chunks: EncodedVideoChunk[] = []
  let decoderConfig: VideoDecoderConfig | null = null
  const encoder = new VideoEncoder({
    output(chunk, metadata) {
      chunks.push(chunk)
      if (decoderConfig === null && metadata?.decoderConfig) {
        decoderConfig = metadata.decoderConfig
      }
    },
    error(error) {
      throw error
    },
  })
  // ~0.1 bits per pixel per frame, as in transcode.ts.
  const bitrate = Math.round(width * height * 30 * 0.1)
  encoder.configure({ codec: "vp8", width, height, bitrate, framerate: 30 })

  // Each decoded source frame is tiled into every cell of the atlas grid,
  // then the whole atlas frame is encoded. (Cells share content here —
  // this is a decode-throughput test, not a visual one.)
  let frameIndex = 0
  const decoder = new VideoDecoder({
    output(frame) {
      const timestamp = frame.timestamp
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          context.drawImage(frame, col * cellWidth, row * cellHeight, cellWidth, cellHeight)
        }
      }
      frame.close()
      const atlasFrame = new VideoFrame(canvas, { timestamp })
      encoder.encode(atlasFrame, { keyFrame: frameIndex === 0 })
      atlasFrame.close()
      frameIndex++
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

  await encoder.flush()
  encoder.close()

  if (decoderConfig === null) {
    throw new Error("composite: encoder produced no decoder config")
  }
  if (chunks.length === 0 || chunks[0].type !== "key") {
    throw new Error("composite: first re-encoded chunk is not a keyframe")
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
  }
}
