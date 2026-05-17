// One SW VideoDecoder per worker. Receives config + raw chunk bytes,
// rebuilds EncodedVideoChunks inside the worker (chunks aren't
// transferable directly), loops decode flat-out until told to stop.
// All decoded frames are closed inside the worker — never crossed
// back to main. Periodically posts a frame count.

import { wait } from "../../src/utils"

interface RawChunk {
  type: EncodedVideoChunkType
  timestamp: number
  duration: number | null
  data: ArrayBuffer
}

interface StartRequest {
  type: "start"
  config: VideoDecoderConfig
  chunks: RawChunk[]
  runSeconds: number
  maxQueue: number
  pref: HardwareAcceleration
}

interface StopRequest {
  type: "stop"
}

type Request = StartRequest | StopRequest

interface DoneResponse {
  type: "done"
  framesDecoded: number
  firstQuarterFps: number
  lastQuarterFps: number
  errors: string[]
}

let running = false

self.onmessage = async (event: MessageEvent<Request>) => {
  if (event.data.type === "stop") {
    running = false
    return
  }
  const { config, chunks: rawChunks, runSeconds, maxQueue, pref } = event.data
  const chunks: EncodedVideoChunk[] = rawChunks.map(
    raw =>
      new EncodedVideoChunk({
        type: raw.type,
        timestamp: raw.timestamp,
        duration: raw.duration ?? undefined,
        data: raw.data,
      }),
  )
  const errors: string[] = []
  let framesDecoded = 0
  const decoder = new VideoDecoder({
    output(frame) {
      framesDecoded++
      frame.close()
    },
    error(error) {
      errors.push(error.message)
    },
  })
  try {
    decoder.configure({ ...config, hardwareAcceleration: pref })
  } catch (error) {
    errors.push(`configure: ${error instanceof Error ? error.message : String(error)}`)
    const response: DoneResponse = {
      type: "done",
      framesDecoded: 0,
      firstQuarterFps: 0,
      lastQuarterFps: 0,
      errors,
    }
    self.postMessage(response)
    return
  }

  running = true
  const quarterMs = (runSeconds * 1000) / 4
  let snapAt1 = 0
  let snapAt3 = 0
  const t1 = setTimeout(() => {
    snapAt1 = framesDecoded
  }, quarterMs)
  const t3 = setTimeout(() => {
    snapAt3 = framesDecoded
  }, quarterMs * 3)

  const task = (async () => {
    while (running) {
      for (const chunk of chunks) {
        if (!running) {
          break
        }
        try {
          decoder.decode(chunk)
        } catch (error) {
          errors.push(`decode: ${error instanceof Error ? error.message : String(error)}`)
          running = false
          break
        }
        while (decoder.decodeQueueSize > maxQueue && running) {
          await wait(1)
        }
      }
      if (!running) {
        break
      }
      try {
        await Promise.race([decoder.flush(), wait(3000)])
        if (!running) {
          break
        }
        decoder.reset()
        decoder.configure({ ...config, hardwareAcceleration: pref })
      } catch {
        break
      }
    }
  })()
  await wait(runSeconds * 1000)
  running = false
  clearTimeout(t1)
  clearTimeout(t3)
  await Promise.race([task, wait(3000)])
  try {
    decoder.close()
  } catch {}

  const response: DoneResponse = {
    type: "done",
    framesDecoded,
    firstQuarterFps: snapAt1 / (quarterMs / 1000),
    lastQuarterFps: (framesDecoded - snapAt3) / (quarterMs / 1000),
    errors,
  }
  self.postMessage(response)
}
