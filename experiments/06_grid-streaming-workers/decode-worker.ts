// One VideoDecoder, in its own Worker. Receives a transcoded cell clip,
// loops it flat-out for runSeconds, posts back the frame count. Used by
// 06_grid-streaming-workers to test whether streaming's poor scaling is
// partly main-thread event-loop contention — give every decoder its own
// thread and see if per-decoder fps improves over 04.

import { wait } from "../../src/utils"

interface DecodeRequest {
  config: VideoDecoderConfig
  chunks: EncodedVideoChunk[]
  runSeconds: number
  maxQueue: number
}

interface DecodeResponse {
  decoded: number
  elapsedSeconds: number
}

self.onmessage = async (event: MessageEvent<DecodeRequest>) => {
  const { config, chunks, runSeconds, maxQueue } = event.data
  let decoded = 0
  const decoder = new VideoDecoder({
    output(frame) {
      decoded++
      frame.close()
    },
    error() {
      // a dead decoder just stops counting — surfaced as low fps
    },
  })
  decoder.configure(config)

  const start = performance.now()
  const deadline = start + runSeconds * 1000
  while (performance.now() < deadline) {
    for (const chunk of chunks) {
      if (performance.now() >= deadline) {
        break
      }
      decoder.decode(chunk)
      while (decoder.decodeQueueSize > maxQueue) {
        await wait(1)
      }
    }
    await decoder.flush()
    decoder.reset()
    decoder.configure(config)
  }
  decoder.close()

  const response: DecodeResponse = {
    decoded,
    elapsedSeconds: (performance.now() - start) / 1000,
  }
  self.postMessage(response)
}
