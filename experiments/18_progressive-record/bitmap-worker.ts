// Read VideoFrames from a transferred MediaStreamTrackProcessor.readable,
// downscale each to a small canvas, emit ImageBitmap per frame.
// Per-frame messages back to main thread. Same pattern as 12b but here
// each stage gets its own worker (lifetime = one recording stage).

interface StartRequest {
  readable: ReadableStream<VideoFrame>
  bitmapWidth: number
  bitmapHeight: number
}

interface BitmapMessage {
  type: "bitmap"
  bitmap: ImageBitmap
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
    context.drawImage(frame, 0, 0, bitmapWidth, bitmapHeight)
    frame.close()
    const bitmap = canvas.transferToImageBitmap()
    bitmapsEmitted++
    const message: BitmapMessage = { type: "bitmap", bitmap }
    ;(self as unknown as { postMessage(m: unknown, t: Transferable[]): void })
      .postMessage(message, [bitmap as unknown as Transferable])
  }
  const finalMessage: DoneMessage = { type: "done", bitmapsEmitted }
  self.postMessage(finalMessage)
}
