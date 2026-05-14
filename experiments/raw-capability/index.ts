// raw-capability — what are the device's raw decode/upload limits?
// Runs M1 concurrent VideoDecoder ceiling, M2 reset/reconfigure cost,
// M3 single-decoder throughput, M4 texImage2D upload cost. See README.md.

import { recordProbeInput, type ProbeInput } from "../harness/input"
import { reportResult, status } from "../harness/report"
import {
  measureDecoderCeiling,
  measureReconfigureCost,
  measureThroughput,
  measureUploadCost,
} from "./measure"

// Experiment parameters — recorded into result.json so the run is
// reproducible. To vary one, edit here and commit (see README.md).
const params = {
  // At 720p, 64 concurrent decoders OOM-crashed the A15 mid-M1. Kept
  // low so the run completes and yields M2/M3/M4 at realistic res; M1's
  // real ceiling at 720p is "crashes above N", measured by bumping this.
  maxDecoders: 16,
  reconfigureIterations: 30,
  uploadIterations: 60,
  recordSeconds: 6,
  // Realistic capture resolutions — what a cell's source clip would
  // actually be recorded at. The camera negotiates the nearest it
  // supports; result.json records the actual dimensions.
  highRes: { width: 1280, height: 720 },
  lowRes: { width: 640, height: 480 },
}

function dims(input: ProbeInput): { requested: string; actual: string } {
  return {
    requested: `${input.requestedWidth}x${input.requestedHeight}`,
    actual: `${input.width}x${input.height}`,
  }
}

async function run(): Promise<void> {
  status(`recording high-res clip (${params.highRes.width}x${params.highRes.height})...`)
  const highInput = await recordProbeInput(
    params.highRes.width,
    params.highRes.height,
    params.recordSeconds,
  )
  status(`  got ${highInput.width}x${highInput.height}, ${highInput.chunks.length} chunks`)

  status(`recording low-res clip (${params.lowRes.width}x${params.lowRes.height})...`)
  const lowInput = await recordProbeInput(
    params.lowRes.width,
    params.lowRes.height,
    params.recordSeconds,
  )
  status(`  got ${lowInput.width}x${lowInput.height}, ${lowInput.chunks.length} chunks`)

  status("M1: concurrent decoder ceiling...")
  const decoderCeiling = await measureDecoderCeiling(highInput, params.maxDecoders)
  status(`  ceiling=${decoderCeiling.ceiling} (${decoderCeiling.stoppedBy})`)

  status("M2: reset/reconfigure cost...")
  const reconfigure = await measureReconfigureCost(highInput, params.reconfigureIterations)
  status(`  mean=${reconfigure.meanMs.toFixed(2)}ms`)

  status("M3: single-decoder throughput (high-res)...")
  const highThroughput = await measureThroughput(highInput)
  status(
    `  ${highThroughput.framesPerSecond.toFixed(1)} fps, budget=${highThroughput.realtimeCellBudget.toFixed(1)} cells`,
  )

  status("M3: single-decoder throughput (low-res)...")
  const lowThroughput = await measureThroughput(lowInput)
  status(
    `  ${lowThroughput.framesPerSecond.toFixed(1)} fps, budget=${lowThroughput.realtimeCellBudget.toFixed(1)} cells`,
  )

  status("M4: texImage2D upload cost (high-res)...")
  const highUpload = await measureUploadCost(highInput, params.uploadIterations)
  status(`  mean=${highUpload.meanMs.toFixed(3)}ms`)

  status("M4: texImage2D upload cost (low-res)...")
  const lowUpload = await measureUploadCost(lowInput, params.uploadIterations)
  status(`  mean=${lowUpload.meanMs.toFixed(3)}ms`)

  status("done.")
  reportResult("raw-capability", params, {
    highRes: { input: dims(highInput), throughput: highThroughput, upload: highUpload },
    lowRes: { input: dims(lowInput), throughput: lowThroughput, upload: lowUpload },
    decoderCeiling,
    reconfigure,
  })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("raw-capability", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
