// Long-lived chunk-worker for 18g. Maintains a per-cell cache of
// pre-decoded ImageBitmaps so each new stage only decodes ONE new
// source clip (instead of all N as 18e's worker did per build).
//
// Messages:
//   init({ cellWidth, cellHeight, atlasWidth, atlasHeight })
//     — set up canvases once
//   add-source({ cellId, source })
//     — decode this source's chunks into bitmaps, store under cellId
//   build-chunk({ cellOrder, frameStart, frameEnd })
//     — assemble + encode one atlas chunk using cached bitmaps for
//       the given cell order in the given frame range
//   dispose()
//     — release everything

import type { ProbeInput } from "../harness/input"

interface InitRequest {
  type: "init"
  cellWidth: number
  cellHeight: number
  atlasWidth: number
  atlasHeight: number
}
interface AddSourceRequest {
  type: "add-source"
  cellId: number
  source: ProbeInput
}
interface BuildChunkRequest {
  type: "build-chunk"
  cellOrder: number[]
  frameStart: number
  frameEnd: number
  cols: number
  rows: number
}
interface DisposeRequest {
  type: "dispose"
}
type Request = InitRequest | AddSourceRequest | BuildChunkRequest | DisposeRequest

interface InitedMessage {
  type: "inited"
}
interface SourceAddedMessage {
  type: "source-added"
  cellId: number
  frameCount: number
  decodeMs: number
}
interface ChunkBuiltMessage {
  type: "chunk-built"
  frameStart: number
  frameEnd: number
  compositeMs: number
  atlasBytes: number
  atlas: ProbeInput
}
interface DisposedMessage {
  type: "disposed"
}
type Response = InitedMessage | SourceAddedMessage | ChunkBuiltMessage | DisposedMessage

let cellWidth = 0
let cellHeight = 0
let atlasWidth = 0
let atlasHeight = 0
let decodeCanvas: OffscreenCanvas | null = null
let decodeContext: OffscreenCanvasRenderingContext2D | null = null
let atlasCanvas: OffscreenCanvas | null = null
let atlasContext: OffscreenCanvasRenderingContext2D | null = null
const bitmapsByCellId = new Map<number, ImageBitmap[]>()

async function decodeSource(source: ProbeInput): Promise<ImageBitmap[]> {
  if (decodeContext === null || decodeCanvas === null) {
    throw new Error("decodeSource: not inited")
  }
  const bitmaps: ImageBitmap[] = []
  const decoder = new VideoDecoder({
    output(frame) {
      decodeContext!.drawImage(frame, 0, 0, cellWidth, cellHeight)
      frame.close()
      bitmaps.push(decodeCanvas!.transferToImageBitmap())
    },
    error(error) {
      throw error
    },
  })
  decoder.configure(source.config)
  // Yield occasionally so this doesn't starve other workers / main
  // thread tasks. Every 30 frames, await a microtask.
  let i = 0
  for (const chunk of source.chunks) {
    decoder.decode(chunk)
    i++
    if (i % 30 === 0) {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
  }
  await decoder.flush()
  decoder.close()
  return bitmaps
}

async function buildChunk(
  cellOrder: number[],
  frameStart: number,
  frameEnd: number,
  cols: number,
  rows: number,
): Promise<{ atlas: ProbeInput; compositeMs: number; atlasBytes: number }> {
  if (atlasContext === null || atlasCanvas === null) {
    throw new Error("buildChunk: not inited")
  }
  if (cellOrder.length !== cols * rows) {
    throw new Error(`buildChunk: cellOrder ${cellOrder.length} ≠ cols×rows ${cols * rows}`)
  }
  const start = performance.now()
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
  const bitrate = Math.round(atlasWidth * atlasHeight * 30 * 0.1)
  encoder.configure({
    codec: "vp8",
    width: atlasWidth,
    height: atlasHeight,
    bitrate,
    framerate: 30,
  })
  for (let t = frameStart; t < frameEnd; t++) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cellId = cellOrder[r * cols + c]
        const bitmaps = bitmapsByCellId.get(cellId)
        if (bitmaps === undefined || t >= bitmaps.length) {
          continue
        }
        atlasContext.drawImage(bitmaps[t], c * cellWidth, r * cellHeight, cellWidth, cellHeight)
      }
    }
    const atlasFrame = new VideoFrame(atlasCanvas, {
      timestamp: (t - frameStart) * Math.round(1_000_000 / 30),
    })
    encoder.encode(atlasFrame, { keyFrame: t === frameStart })
    atlasFrame.close()
  }
  await encoder.flush()
  encoder.close()
  if (decoderConfig === null) {
    throw new Error("buildChunk: no decoder config from encoder")
  }
  if (chunks.length === 0 || chunks[0].type !== "key") {
    throw new Error("buildChunk: first chunk not a keyframe")
  }
  return {
    atlas: {
      config: decoderConfig,
      chunks,
      width: atlasWidth,
      height: atlasHeight,
      requestedWidth: atlasWidth,
      requestedHeight: atlasHeight,
    },
    compositeMs: performance.now() - start,
    atlasBytes: totalBytes,
  }
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const message = event.data
  if (message.type === "init") {
    cellWidth = message.cellWidth
    cellHeight = message.cellHeight
    atlasWidth = message.atlasWidth
    atlasHeight = message.atlasHeight
    decodeCanvas = new OffscreenCanvas(cellWidth, cellHeight)
    const dc = decodeCanvas.getContext("2d")
    if (dc === null) {
      throw new Error("init: no decode 2d context")
    }
    decodeContext = dc
    atlasCanvas = new OffscreenCanvas(atlasWidth, atlasHeight)
    const ac = atlasCanvas.getContext("2d")
    if (ac === null) {
      throw new Error("init: no atlas 2d context")
    }
    atlasContext = ac
    self.postMessage({ type: "inited" } satisfies InitedMessage)
    return
  }
  if (message.type === "add-source") {
    const start = performance.now()
    const bitmaps = await decodeSource(message.source)
    bitmapsByCellId.set(message.cellId, bitmaps)
    const response: SourceAddedMessage = {
      type: "source-added",
      cellId: message.cellId,
      frameCount: bitmaps.length,
      decodeMs: performance.now() - start,
    }
    self.postMessage(response)
    return
  }
  if (message.type === "build-chunk") {
    const result = await buildChunk(
      message.cellOrder,
      message.frameStart,
      message.frameEnd,
      message.cols,
      message.rows,
    )
    const response: ChunkBuiltMessage = {
      type: "chunk-built",
      frameStart: message.frameStart,
      frameEnd: message.frameEnd,
      compositeMs: result.compositeMs,
      atlasBytes: result.atlasBytes,
      atlas: result.atlas,
    }
    self.postMessage(response)
    return
  }
  if (message.type === "dispose") {
    for (const arr of bitmapsByCellId.values()) {
      for (const bitmap of arr) {
        bitmap.close()
      }
    }
    bitmapsByCellId.clear()
    decodeContext = null
    decodeCanvas = null
    atlasContext = null
    atlasCanvas = null
    self.postMessage({ type: "disposed" } satisfies DisposedMessage)
    return
  }
}

export {}
