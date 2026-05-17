// Warm worker for 26b. Reads one AV1 file from OPFS via
// SyncAccessHandle, decodes via VideoDecoder, uses
// VideoFrame.copyTo({format:'RGBA'}) to extract pixels into a Uint8Array
// without canvas roundtrip, writes the concatenated RGBA bytes back
// to OPFS via SyncAccessHandle, posts stats to main.

interface WarmRequest {
  type: "warm"
  cellId: number
  dirName: string
  av1FileName: string
  rgbaFileName: string
  config: VideoDecoderConfig
  width: number
  height: number
}

interface DoneResponse {
  type: "done"
  cellId: number
  framesProduced: number
  decodeMs: number
  writeMs: number
  totalMs: number
  errors: string[]
}

self.onmessage = async (event: MessageEvent<WarmRequest>) => {
  if (event.data.type !== "warm") {
    return
  }
  const req = event.data
  const start = performance.now()
  const errors: string[] = []

  let framesProduced = 0
  let decodeMs = 0
  let writeMs = 0

  try {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle(req.dirName, { create: false })
    const av1Handle = await dir.getFileHandle(req.av1FileName, { create: false })
    const av1Sah = await av1Handle.createSyncAccessHandle()
    const av1Size = av1Sah.getSize()
    const av1Buf = new ArrayBuffer(av1Size)
    av1Sah.read(new Uint8Array(av1Buf), { at: 0 })
    av1Sah.close()

    const view = new DataView(av1Buf)
    const chunks: EncodedVideoChunk[] = []
    let off = 0
    let timestamp = 0
    while (off + 4 <= av1Size) {
      const len = view.getUint32(off, false)
      off += 4
      if (off + len > av1Size) {
        break
      }
      chunks.push(
        new EncodedVideoChunk({
          type: chunks.length === 0 ? "key" : "delta",
          timestamp,
          data: av1Buf.slice(off, off + len),
        }),
      )
      off += len
      timestamp += 33333
    }

    const decodeStart = performance.now()
    const rgbaBufferSize = req.width * req.height * 4
    const collected: Uint8Array[] = []
    const pending: Promise<void>[] = []
    const decoder = new VideoDecoder({
      output: frame => {
        const buf = new Uint8Array(rgbaBufferSize)
        const promise = frame
          .copyTo(buf, { format: "RGBA" })
          .then(() => {
            collected.push(buf)
            frame.close()
          })
          .catch(error => {
            errors.push(`copyTo: ${error instanceof Error ? error.message : String(error)}`)
            frame.close()
          })
        pending.push(promise)
      },
      error: error => {
        errors.push(`dec: ${error.message}`)
      },
    })
    try {
      decoder.configure({ ...req.config, hardwareAcceleration: "prefer-software" })
    } catch (error) {
      errors.push(`configure: ${error instanceof Error ? error.message : String(error)}`)
    }
    for (const chunk of chunks) {
      try {
        decoder.decode(chunk)
      } catch (error) {
        errors.push(`decode: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    try {
      await decoder.flush()
    } catch (error) {
      errors.push(`flush: ${error instanceof Error ? error.message : String(error)}`)
    }
    decoder.close()
    await Promise.all(pending)
    framesProduced = collected.length
    decodeMs = performance.now() - decodeStart

    // Write all collected RGBA frames to OPFS via SyncAccessHandle.
    const writeStart = performance.now()
    const rgbaHandle = await dir.getFileHandle(req.rgbaFileName, { create: true })
    const rgbaSah = await rgbaHandle.createSyncAccessHandle()
    let writeOff = 0
    for (const frame of collected) {
      rgbaSah.write(frame, { at: writeOff })
      writeOff += frame.byteLength
    }
    rgbaSah.flush()
    rgbaSah.close()
    writeMs = performance.now() - writeStart
  } catch (error) {
    errors.push(`outer: ${error instanceof Error ? error.message : String(error)}`)
  }

  const response: DoneResponse = {
    type: "done",
    cellId: req.cellId,
    framesProduced,
    decodeMs,
    writeMs,
    totalMs: performance.now() - start,
    errors,
  }
  self.postMessage(response)
}
