// compositing-workers — can the composite pipeline run off the main
// thread?
//
// 05_compositing-full-video showed the composite wins on throughput, but
// the atlas BUILD takes ~9-13 s — far too long to block the UI thread.
// 06 showed Workers don't change decode throughput, so this isn't a
// speed experiment: it's a feasibility check. It runs the whole
// composite pipeline (build + decode) inside a Worker and confirms it
// produces the same results as 05 — i.e. the real app can keep its main
// thread free for rendering while an atlas rebuilds.

import { recordProbeInput, type ProbeInput } from "../harness/input"
import { reportResult, status } from "../harness/report"

const params = {
  captureResolution: { width: 1280, height: 720 },
  atlasResolution: { width: 1080, height: 1965 },
  gridSizes: [4, 9, 16, 25],
  recordSeconds: 6,
  runSeconds: 6,
  maxQueue: 8,
  realtimeFps: 28,
}

interface GridResponse {
  n: number
  atlas: { target: string; actual: string }
  compositeMs: number
  fps: number
}

/** Build + decode-test one atlas grid entirely inside a Worker. */
function runGridInWorker(source: ProbeInput, n: number): Promise<GridResponse> {
  const worker = new Worker(new URL("./composite-worker.ts", import.meta.url), { type: "module" })
  const { promise, resolve } = Promise.withResolvers<GridResponse>()
  worker.onmessage = (event: MessageEvent<GridResponse>) => {
    resolve(event.data)
    worker.terminate()
  }
  worker.postMessage({
    source,
    n,
    atlasWidth: params.atlasResolution.width,
    atlasHeight: params.atlasResolution.height,
    runSeconds: params.runSeconds,
    maxQueue: params.maxQueue,
  })
  return promise
}

async function run(): Promise<void> {
  status(`recording capture clip (${params.captureResolution.width}x${params.captureResolution.height})...`)
  const source = await recordProbeInput(
    params.captureResolution.width,
    params.captureResolution.height,
    params.recordSeconds,
  )
  status(`  got ${source.width}x${source.height}, ${source.chunks.length} chunks`)

  const grids: Array<GridResponse & { realtimeOk: boolean }> = []
  for (const n of params.gridSizes) {
    status(`N=${n}: building + decoding atlas in a Worker...`)
    const result = await runGridInWorker(source, n)
    const realtimeOk = result.fps >= params.realtimeFps
    status(
      `  N=${n}: atlas ${result.atlas.actual}, built in ${result.compositeMs.toFixed(0)}ms, ${result.fps.toFixed(1)} fps  realtimeOk=${realtimeOk}`,
    )
    grids.push({ ...result, realtimeOk })
  }
  status("done.")
  reportResult("compositing-workers", params, {
    source: { requested: `${source.requestedWidth}x${source.requestedHeight}`, actual: `${source.width}x${source.height}` },
    grids,
  })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("compositing-workers", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
