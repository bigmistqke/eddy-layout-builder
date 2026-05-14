// The composite pipeline — atlas build + atlas decode — entirely inside
// a Worker. Used by 07_compositing-workers to confirm the ~10 s build
// (and the playback decode) can run off the main thread, so the real
// app's UI thread stays free. One message in (source clip + grid spec),
// one message out (build time + decode fps) per grid.

import { composite } from "../harness/composite"
import type { ProbeInput } from "../harness/input"
import { wait } from "../../src/utils"

interface GridRequest {
  source: ProbeInput
  n: number
  atlasWidth: number
  atlasHeight: number
  runSeconds: number
  maxQueue: number
}

interface GridResponse {
  n: number
  atlas: { target: string; actual: string }
  compositeMs: number
  fps: number
}

/** Decode `input`'s chunks on one decoder, looping until `deadline`. */
async function runOneDecoder(
  input: ProbeInput,
  deadline: number,
  maxQueue: number,
): Promise<number> {
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
  decoder.configure(input.config)
  while (performance.now() < deadline) {
    for (const chunk of input.chunks) {
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
    decoder.configure(input.config)
  }
  decoder.close()
  return decoded
}

self.onmessage = async (event: MessageEvent<GridRequest>) => {
  const { source, n, atlasWidth, atlasHeight, runSeconds, maxQueue } = event.data
  const side = Math.sqrt(n)
  const { output: atlas, compositeMs } = await composite(source, side, side, atlasWidth, atlasHeight)

  const start = performance.now()
  const deadline = start + runSeconds * 1000
  const count = await runOneDecoder(atlas, deadline, maxQueue)
  const fps = count / ((performance.now() - start) / 1000)

  const response: GridResponse = {
    n,
    atlas: {
      target: `${atlasWidth}x${atlasHeight}`,
      actual: `${atlas.width}x${atlas.height}`,
    },
    compositeMs,
    fps,
  }
  self.postMessage(response)
}
