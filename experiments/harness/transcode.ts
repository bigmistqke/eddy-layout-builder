import type { ProbeInput } from "./input"

// Downscale a recorded clip to an arbitrary smaller resolution. The
// camera only offers a few discrete capture resolutions — it will NOT
// hand back, say, a 270×491 stream just because you asked. So a real
// streaming pipeline has to downscale after capture itself; this does
// exactly that (decode → draw to a cell-sized canvas → re-encode VP8)
// and reports the cost, which is itself a real pipeline cost.

export interface TranscodeResult {
  /** The downscaled clip, shaped like a ProbeInput — ready to decode. */
  output: ProbeInput
  /** Wall-clock ms for the whole decode → downscale → re-encode pass. */
  transcodeMs: number
}

export async function transcode(
  source: ProbeInput,
  targetWidth: number,
  targetHeight: number,
): Promise<TranscodeResult> {
  const start = performance.now()
  // VP8 encodes in 16×16 macroblocks — dimensions that aren't multiples
  // of 16 force the encoder to pad, and the padded result decodes
  // measurably slower. Snap to the nearest multiple of 16. (Not
  // power-of-2: that would distort the target cell size far more than
  // macroblock alignment requires — e.g. 540 → 512 vs 544.)
  const snap16 = (value: number): number => Math.max(16, Math.round(value / 16) * 16)
  const width = snap16(targetWidth)
  const height = snap16(targetHeight)
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext("2d")
  if (context === null) {
    throw new Error("transcode: no 2d context")
  }

  // Encoder: collects the re-encoded chunks + the decoder config its
  // output is described by (needed to decode the result later).
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
  // Scale bitrate with resolution. A fixed bitrate over-bitrates small
  // cells, making their decode bitrate-bound rather than resolution-
  // bound — so smaller cells would (wrongly) decode *slower*. ~0.1 bits
  // per pixel per frame is a reasonable VP8 target.
  const bitrate = Math.round(width * height * 30 * 0.1)
  encoder.configure({
    codec: "vp8",
    width,
    height,
    bitrate,
    framerate: 30,
  })

  // Decoder: every decoded frame is drawn to the target-sized canvas and
  // handed straight to the encoder.
  let frameIndex = 0
  const decoder = new VideoDecoder({
    output(frame) {
      const timestamp = frame.timestamp
      context.drawImage(frame, 0, 0, width, height)
      frame.close()
      const scaled = new VideoFrame(canvas, { timestamp })
      encoder.encode(scaled, { keyFrame: frameIndex === 0 })
      scaled.close()
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
    throw new Error("transcode: encoder produced no decoder config")
  }
  if (chunks.length === 0 || chunks[0].type !== "key") {
    throw new Error("transcode: first re-encoded chunk is not a keyframe")
  }
  return {
    output: {
      config: decoderConfig,
      chunks,
      width,
      height,
      requestedWidth: targetWidth,
      requestedHeight: targetHeight,
    },
    transcodeMs: performance.now() - start,
  }
}
