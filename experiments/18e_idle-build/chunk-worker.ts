// Worker that pre-decodes N source clips once, then builds atlas
// chunks on demand. Main thread requests one chunk at a time; worker
// yields back via postMessage between chunks so the main scheduler
// can prioritise other work (rAF, capture) before the next chunk.

import { createChunkComposer, type ChunkAtlas, type ChunkComposer } from "./composite-chunk"
import type { ProbeInput } from "../harness/input"

interface PrepareRequest {
  type: "prepare"
  sources: ProbeInput[]
  cols: number
  rows: number
  atlasWidth: number
  atlasHeight: number
}

interface BuildChunkRequest {
  type: "build-chunk"
  frameStart: number
  frameEnd: number
}

interface DisposeRequest {
  type: "dispose"
}

type Request = PrepareRequest | BuildChunkRequest | DisposeRequest

interface PreparedMessage {
  type: "prepared"
  totalFrames: number
}

interface ChunkBuiltMessage {
  type: "chunk-built"
  chunk: ChunkAtlas
}

interface DisposedMessage {
  type: "disposed"
}

let composer: ChunkComposer | null = null

self.onmessage = async (event: MessageEvent<Request>) => {
  const message = event.data
  if (message.type === "prepare") {
    composer = await createChunkComposer(
      message.sources,
      message.cols,
      message.rows,
      message.atlasWidth,
      message.atlasHeight,
    )
    const response: PreparedMessage = { type: "prepared", totalFrames: composer.totalFrames() }
    self.postMessage(response)
    return
  }
  if (message.type === "build-chunk") {
    if (composer === null) {
      throw new Error("chunk-worker: build-chunk before prepare")
    }
    const chunk = await composer.buildChunk(message.frameStart, message.frameEnd)
    const response: ChunkBuiltMessage = { type: "chunk-built", chunk }
    self.postMessage(response)
    return
  }
  if (message.type === "dispose") {
    composer?.dispose()
    composer = null
    const response: DisposedMessage = { type: "disposed" }
    self.postMessage(response)
    return
  }
}

export {}
