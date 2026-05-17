// Atlas rebuild worker. Holds a cached copy of the source clip,
// rebuilds an AV1 atlas (decode source → tile to OffscreenCanvas →
// encode) per `build` request, posts back encoded chunks + config.

interface RawChunk {
  type: EncodedVideoChunkType
  timestamp: number
  duration: number | null
  data: ArrayBuffer
}

interface InitMessage {
  type: "init"
  sourceConfig: VideoDecoderConfig
  sourceChunks: RawChunk[]
}

interface BuildMessage {
  type: "build"
  jobId: number
  atlasCols: number
  atlasRows: number
  cellWidth: number
  cellHeight: number
  codecString: string
  bitratePerPixel: number
  framerate: number
}

type Request = InitMessage | BuildMessage

interface BuildDoneMessage {
  type: "done"
  jobId: number
  ok: boolean
  decoderConfig: VideoDecoderConfig | null
  chunks: RawChunk[]
  buildMs: number
  errors: string[]
}

interface ReadyMessage {
  type: "ready"
}

let cachedSourceConfig: VideoDecoderConfig | null = null
let cachedSourceChunks: EncodedVideoChunk[] = []

async function build(req: BuildMessage): Promise<BuildDoneMessage> {
  const errors: string[] = []
  const start = performance.now()
  if (cachedSourceConfig === null) {
    return {
      type: "done",
      jobId: req.jobId,
      ok: false,
      decoderConfig: null,
      chunks: [],
      buildMs: 0,
      errors: ["not initialised"],
    }
  }
  const width = req.cellWidth * req.atlasCols
  const height = req.cellHeight * req.atlasRows
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext("2d")
  if (context === null) {
    return {
      type: "done",
      jobId: req.jobId,
      ok: false,
      decoderConfig: null,
      chunks: [],
      buildMs: 0,
      errors: ["no 2d context"],
    }
  }
  const outChunks: EncodedVideoChunk[] = []
  let outDecoderConfig: VideoDecoderConfig | null = null
  const bitrate = Math.round(width * height * req.framerate * req.bitratePerPixel)
  const encoder = new VideoEncoder({
    output(chunk, metadata) {
      outChunks.push(chunk)
      if (outDecoderConfig === null && metadata?.decoderConfig) {
        outDecoderConfig = metadata.decoderConfig
      }
    },
    error(error) {
      errors.push(`enc: ${error.message}`)
    },
  })
  try {
    encoder.configure({
      codec: req.codecString,
      width,
      height,
      bitrate,
      framerate: req.framerate,
    })
  } catch (error) {
    encoder.close()
    errors.push(`enc-configure: ${error instanceof Error ? error.message : String(error)}`)
    return {
      type: "done",
      jobId: req.jobId,
      ok: false,
      decoderConfig: null,
      chunks: [],
      buildMs: performance.now() - start,
      errors,
    }
  }
  let frameIdx = 0
  const sourceDecoder = new VideoDecoder({
    output(frame) {
      try {
        for (let row = 0; row < req.atlasRows; row++) {
          for (let col = 0; col < req.atlasCols; col++) {
            context.drawImage(
              frame,
              col * req.cellWidth,
              row * req.cellHeight,
              req.cellWidth,
              req.cellHeight,
            )
          }
        }
        const atlasFrame = new VideoFrame(canvas, { timestamp: frame.timestamp })
        encoder.encode(atlasFrame, { keyFrame: frameIdx === 0 })
        atlasFrame.close()
      } catch (error) {
        errors.push(`scale: ${error instanceof Error ? error.message : String(error)}`)
      }
      frame.close()
      frameIdx++
    },
    error(error) {
      errors.push(`src-dec: ${error.message}`)
    },
  })
  sourceDecoder.configure(cachedSourceConfig)
  for (const chunk of cachedSourceChunks) {
    sourceDecoder.decode(chunk)
  }
  try {
    await sourceDecoder.flush()
  } catch (error) {
    errors.push(`src-flush: ${error instanceof Error ? error.message : String(error)}`)
  }
  sourceDecoder.close()
  try {
    await encoder.flush()
  } catch (error) {
    errors.push(`enc-flush: ${error instanceof Error ? error.message : String(error)}`)
  }
  encoder.close()

  if (outChunks.length === 0 || outDecoderConfig === null) {
    return {
      type: "done",
      jobId: req.jobId,
      ok: false,
      decoderConfig: null,
      chunks: [],
      buildMs: performance.now() - start,
      errors: [...errors, "no output"],
    }
  }

  const rawChunks: RawChunk[] = outChunks.map(chunk => {
    const buffer = new ArrayBuffer(chunk.byteLength)
    chunk.copyTo(new Uint8Array(buffer))
    return {
      type: chunk.type,
      timestamp: chunk.timestamp,
      duration: chunk.duration ?? null,
      data: buffer,
    }
  })

  return {
    type: "done",
    jobId: req.jobId,
    ok: true,
    decoderConfig: outDecoderConfig,
    chunks: rawChunks,
    buildMs: performance.now() - start,
    errors,
  }
}

self.onmessage = async (event: MessageEvent<Request>) => {
  if (event.data.type === "init") {
    cachedSourceConfig = event.data.sourceConfig
    cachedSourceChunks = event.data.sourceChunks.map(
      raw =>
        new EncodedVideoChunk({
          type: raw.type,
          timestamp: raw.timestamp,
          duration: raw.duration ?? undefined,
          data: raw.data,
        }),
    )
    const ready: ReadyMessage = { type: "ready" }
    self.postMessage(ready)
    return
  }
  if (event.data.type === "build") {
    const response = await build(event.data)
    self.postMessage(
      response,
      response.chunks.map(c => c.data),
    )
    return
  }
}
