// Background atlas build, in a Worker. 07 showed harness/composite.ts is
// worker-safe; this experiment uses that to put the build off the main
// thread while capture + playback run on it — the production shape.

import { composite } from "../harness/composite"
import type { ProbeInput } from "../harness/input"

interface BuildRequest {
  source: ProbeInput
  n: number
  atlasWidth: number
  atlasHeight: number
}

interface BuildResponse {
  compositeMs: number
  atlas: { width: number; height: number }
}

self.onmessage = async (event: MessageEvent<BuildRequest>) => {
  const { source, n, atlasWidth, atlasHeight } = event.data
  const side = Math.sqrt(n)
  const { output, compositeMs } = await composite(source, side, side, atlasWidth, atlasHeight)
  const response: BuildResponse = {
    compositeMs,
    atlas: { width: output.width, height: output.height },
  }
  self.postMessage(response)
}
