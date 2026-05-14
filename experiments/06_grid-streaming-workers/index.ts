// grid-streaming-workers — is streaming's poor scaling partly main-thread
// contention?
//
// 04_grid-streaming-transcoded ran all N VideoDecoders on the main
// thread — N decoders, N output callbacks, N backpressure-polling loops,
// all on one event loop. This is 04 with each decoder moved into its own
// Web Worker, so there is zero main-thread decode contention. Same
// transcode step, same grids, same metrics — only the threading differs.
//
// Compare per-decoder fps to 04: if it improves, contention was a real
// factor; if it doesn't, streaming is genuinely hardware-decode-bound
// and workers won't save it.

import { recordProbeInput, type ProbeInput } from "../harness/input"
import { reportResult, status } from "../harness/report"
import { transcode } from "../harness/transcode"

const params = {
  captureResolution: { width: 1280, height: 720 },
  totalResolution: { width: 1080, height: 1965 },
  gridSizes: [4, 9, 16, 25],
  recordSeconds: 6,
  runSeconds: 6,
  maxQueue: 8,
  realtimeFps: 28,
}

interface DecodeResponse {
  decoded: number
  elapsedSeconds: number
}

/** Run one decoder in its own Worker; resolve with its frame count. */
function runDecoderInWorker(clip: ProbeInput): Promise<DecodeResponse> {
  const worker = new Worker(new URL("./decode-worker.ts", import.meta.url), { type: "module" })
  const { promise, resolve } = Promise.withResolvers<DecodeResponse>()
  worker.onmessage = (event: MessageEvent<DecodeResponse>) => {
    resolve(event.data)
    worker.terminate()
  }
  worker.postMessage({
    config: clip.config,
    chunks: clip.chunks,
    runSeconds: params.runSeconds,
    maxQueue: params.maxQueue,
  })
  return promise
}

interface GridResult {
  n: number
  cell: { target: string; actual: string }
  transcodeMs: number
  perDecoderFps: number[]
  minFps: number
  aggregateFps: number
  realtimeOk: boolean
}

async function measureGrid(source: ProbeInput, n: number): Promise<GridResult> {
  const side = Math.sqrt(n)
  const cellWidth = Math.round(params.totalResolution.width / side)
  const cellHeight = Math.round(params.totalResolution.height / side)
  status(`N=${n}: transcoding ${source.width}x${source.height} → ${cellWidth}x${cellHeight}...`)
  const { output: cellClip, transcodeMs } = await transcode(source, cellWidth, cellHeight)
  status(
    `  transcoded in ${transcodeMs.toFixed(0)}ms — running ${n} decoders, one per Worker...`,
  )

  const responses = await Promise.all(
    Array.from({ length: n }, () => runDecoderInWorker(cellClip)),
  )
  const perDecoderFps = responses.map(r => r.decoded / r.elapsedSeconds)
  const minFps = Math.min(...perDecoderFps)
  const aggregateFps = perDecoderFps.reduce((sum, fps) => sum + fps, 0)
  const realtimeOk = minFps >= params.realtimeFps
  status(
    `  N=${n}: min=${minFps.toFixed(1)} fps  aggregate=${aggregateFps.toFixed(0)} fps  realtimeOk=${realtimeOk}`,
  )
  return {
    n,
    cell: {
      target: `${cellWidth}x${cellHeight}`,
      actual: `${cellClip.width}x${cellClip.height}`,
    },
    transcodeMs,
    perDecoderFps,
    minFps,
    aggregateFps,
    realtimeOk,
  }
}

async function run(): Promise<void> {
  status(`recording capture clip (${params.captureResolution.width}x${params.captureResolution.height})...`)
  const source = await recordProbeInput(
    params.captureResolution.width,
    params.captureResolution.height,
    params.recordSeconds,
  )
  status(`  got ${source.width}x${source.height}, ${source.chunks.length} chunks`)

  const grids: GridResult[] = []
  for (const n of params.gridSizes) {
    grids.push(await measureGrid(source, n))
  }
  status("done.")
  reportResult("grid-streaming-workers", params, {
    source: { requested: `${source.requestedWidth}x${source.requestedHeight}`, actual: `${source.width}x${source.height}` },
    grids,
  })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("grid-streaming-workers", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
