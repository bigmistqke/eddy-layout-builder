// Rebuild a sub-atlas in a Worker — same pattern as 10/11.

import { composite } from "../harness/composite"
import type { ProbeInput } from "../harness/input"

interface BuildRequest {
  source: ProbeInput
  cols: number
  rows: number
  width: number
  height: number
}

interface BuildResponse {
  compositeMs: number
  width: number
  height: number
}

self.onmessage = async (event: MessageEvent<BuildRequest>) => {
  const { source, cols, rows, width, height } = event.data
  const { output, compositeMs } = await composite(source, cols, rows, width, height)
  const response: BuildResponse = { compositeMs, width: output.width, height: output.height }
  self.postMessage(response)
}
