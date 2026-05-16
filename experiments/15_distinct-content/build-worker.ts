// Rebuild a sub-atlas in a Worker. Same shape as 10/11's build-worker
// but uses compositeDistinct so the rebuild is realistic distinct-
// content cost, not the optimistic identical-tile cost.

import { compositeDistinct } from "./composite-distinct"
import type { ProbeInput } from "../harness/input"

interface BuildRequest {
  sources: ProbeInput[]
  cols: number
  rows: number
  width: number
  height: number
}

interface BuildResponse {
  compositeMs: number
  atlasBytes: number
  width: number
  height: number
}

self.onmessage = async (event: MessageEvent<BuildRequest>) => {
  const { sources, cols, rows, width, height } = event.data
  const result = await compositeDistinct(sources, cols, rows, width, height)
  const response: BuildResponse = {
    compositeMs: result.compositeMs,
    atlasBytes: result.atlasBytes,
    width: result.output.width,
    height: result.output.height,
  }
  self.postMessage(response)
}
