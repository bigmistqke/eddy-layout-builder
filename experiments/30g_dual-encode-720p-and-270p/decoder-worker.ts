/// <reference lib="webworker" />
// Per-clip looping decoder worker. Receives init with the AV1 chunk
// fixture + VideoDecoderConfig; loops decoding the chunks at 30 fps,
// copying each output frame to RGBA, then closes. Tracks framesDecoded
// and replies on demand. Mirrors the eddy bitmap-source pattern but in
// isolation per worker.

export {}

const worker = self as unknown as DedicatedWorkerGlobalScope

interface InitMessage {
  type: "init"
  chunks: EncodedVideoChunkInit[]
  config: VideoDecoderConfig
  copyWidth: number
  copyHeight: number
  targetFps: number
}
interface PollMessage {
  type: "poll"
}
interface StopMessage {
  type: "stop"
}
type InMessage = InitMessage | PollMessage | StopMessage

interface PollResponse {
  type: "poll-response"
  framesDecoded: number
}
interface ReadyResponse {
  type: "ready"
}

function wait(ms: number): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}

let framesDecoded = 0
let stopped = false

worker.addEventListener("message", (event: MessageEvent<InMessage>) => {
  const message = event.data
  if (message.type === "init") {
    void run(message)
    return
  }
  if (message.type === "poll") {
    const response: PollResponse = { type: "poll-response", framesDecoded }
    worker.postMessage(response)
    return
  }
  if (message.type === "stop") {
    stopped = true
    return
  }
})

async function run(init: InitMessage): Promise<void> {
  const rgbaBuffer = new Uint8Array(init.copyWidth * init.copyHeight * 4)
  const decoder = new VideoDecoder({
    output(frame: VideoFrame): void {
      framesDecoded++
      frame
        .copyTo(rgbaBuffer, { format: "RGBA" })
        .catch(() => {})
        .finally(() => {
          frame.close()
        })
    },
    error(): void {
      // restart on next loop iteration
    },
  })
  decoder.configure(init.config)

  const chunks = init.chunks.map(c => new EncodedVideoChunk(c))
  const tickIntervalMs = 1000 / init.targetFps

  const ready: ReadyResponse = { type: "ready" }
  worker.postMessage(ready)

  while (!stopped) {
    const loopStart = performance.now()
    for (let i = 0; i < chunks.length && !stopped; i++) {
      const scheduled = loopStart + i * tickIntervalMs
      const waitMs = scheduled - performance.now()
      if (waitMs > 0) {
        await wait(waitMs)
      }
      try {
        decoder.decode(chunks[i])
      } catch {
        break
      }
    }
    try {
      await decoder.flush()
    } catch {}
    try {
      decoder.reset()
      decoder.configure(init.config)
    } catch {}
  }
  try {
    decoder.close()
  } catch {}
}
