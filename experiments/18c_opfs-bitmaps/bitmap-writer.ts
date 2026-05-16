// Writes raw RGBA frames to an OPFS file via SyncAccessHandle. One
// instance per recording stage. Reads VideoFrames from a transferred
// MediaStreamTrackProcessor.readable, downscales, appends bytes.

interface StartRequest {
  readable: ReadableStream<VideoFrame>
  bitmapWidth: number
  bitmapHeight: number
  filename: string
}

interface DoneMessage {
  type: "done"
  framesWritten: number
  totalBytes: number
  writeTotalMs: number
}

self.onmessage = async (event: MessageEvent<StartRequest>) => {
  const { readable, bitmapWidth, bitmapHeight, filename } = event.data
  const root = await navigator.storage.getDirectory()
  const handle = await root.getFileHandle(filename, { create: true })
  const access = await (handle as unknown as {
    createSyncAccessHandle(): Promise<{
      truncate(size: number): void
      write(buf: AllowSharedBufferSource, opts?: { at?: number }): number
      flush(): void
      close(): void
    }>
  }).createSyncAccessHandle()
  access.truncate(0)

  const canvas = new OffscreenCanvas(bitmapWidth, bitmapHeight)
  const context = canvas.getContext("2d", { willReadFrequently: true })
  if (context === null) {
    throw new Error("bitmap-writer: no 2d context")
  }

  const reader = readable.getReader()
  let framesWritten = 0
  let writeOffset = 0
  let writeTotalMs = 0
  while (true) {
    const { value: frame, done } = await reader.read()
    if (done) {
      break
    }
    context.drawImage(frame, 0, 0, bitmapWidth, bitmapHeight)
    frame.close()
    const imageData = context.getImageData(0, 0, bitmapWidth, bitmapHeight)
    const writeStart = performance.now()
    access.write(imageData.data, { at: writeOffset })
    writeTotalMs += performance.now() - writeStart
    writeOffset += imageData.data.byteLength
    framesWritten++
  }
  access.flush()
  access.close()
  const response: DoneMessage = {
    type: "done",
    framesWritten,
    totalBytes: writeOffset,
    writeTotalMs,
  }
  self.postMessage(response)
}

export {}
