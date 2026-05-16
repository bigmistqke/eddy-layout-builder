// Rebuild a sub-atlas of N distinct clips. Reuses 15's compositeDistinct
// pattern (decode each source to cell-sized bitmaps, assemble atlas
// frames, re-encode).

import { compositeDistinct } from "../15_distinct-content/composite-distinct"
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
  atlas: ProbeInput
}

self.onmessage = async (event: MessageEvent<BuildRequest>) => {
  const { sources, cols, rows, width, height } = event.data
  const result = await compositeDistinct(sources, cols, rows, width, height)
  const response: BuildResponse = {
    compositeMs: result.compositeMs,
    atlasBytes: result.atlasBytes,
    atlas: result.output,
  }
  self.postMessage(response)
}
