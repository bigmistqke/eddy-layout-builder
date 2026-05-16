// Read VideoFrames from a transferred MediaStreamTrackProcessor.readable,
// downscale each to a small canvas, emit an ImageBitmap. Live; runs as
// long as the readable stays open.

interface StartRequest {
  readable: ReadableStream<VideoFrame>
  bitmapWidth: number
  bitmapHeight: number
}

interface ProgressMessage {
  type: "progress"
  /** ms from worker receiving the VideoFrame to posting the bitmap. */
  latencyMs: number
}

interface DoneMessage {
  type: "done"
  bitmapsEmitted: number
}

self.onmessage = async (event: MessageEvent<StartRequest>) => {
  const { readable, bitmapWidth, bitmapHeight } = event.data
  const canvas = new OffscreenCanvas(bitmapWidth, bitmapHeight)
  const context = canvas.getContext("2d")
  if (context === null) {
    throw new Error("bitmap-worker: no 2d context")
  }
  const reader = readable.getReader()
  let bitmapsEmitted = 0
  while (true) {
    const { value: frame, done } = await reader.read()
    if (done) {
      break
    }
    const arrivedAt = performance.now()
    context.drawImage(frame, 0, 0, bitmapWidth, bitmapHeight)
    frame.close()
    const bitmap = canvas.transferToImageBitmap()
    bitmapsEmitted++
    bitmap.close()
    const progress: ProgressMessage = { type: "progress", latencyMs: performance.now() - arrivedAt }
    self.postMessage(progress)
  }
  const finalMessage: DoneMessage = { type: "done", bitmapsEmitted }
  self.postMessage(finalMessage)
}

export {}
