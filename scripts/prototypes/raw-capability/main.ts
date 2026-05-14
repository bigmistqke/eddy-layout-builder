import { recordProbeInput, type ProbeInput } from "../harness/input"
import {
  measureDecoderCeiling,
  measureReconfigureCost,
  measureThroughput,
  measureUploadCost,
  type DecoderCeilingResult,
  type ReconfigureResult,
  type ThroughputResult,
  type UploadResult,
} from "./measure"

/** Recognizable prefix so the prototype runner / a human can grep the result. */
const RESULT_PREFIX = "[prototype-result]"

const MAX_DECODERS = 32
const RECONFIGURE_ITERATIONS = 30
const UPLOAD_ITERATIONS = 60
const RECORD_SECONDS = 6

interface ProbeResult {
  device: { userAgent: string; viewport: { width: number; height: number } }
  highRes: {
    input: { requested: string; actual: string }
    throughput: ThroughputResult
    upload: UploadResult
  }
  lowRes: {
    input: { requested: string; actual: string }
    throughput: ThroughputResult
    upload: UploadResult
  }
  decoderCeiling: DecoderCeilingResult
  reconfigure: ReconfigureResult
}

const statusElement = document.querySelector<HTMLPreElement>("#status")!

function status(line: string): void {
  statusElement.textContent += `${line}\n`
  // Also to the console so it shows up in the CDP tail.
  console.log(`[device-probe] ${line}`)
}

function dims(input: ProbeInput): { requested: string; actual: string } {
  return {
    requested: `${input.requestedWidth}x${input.requestedHeight}`,
    actual: `${input.width}x${input.height}`,
  }
}

async function run(): Promise<void> {
  status("recording high-res clip (320x240)...")
  const highInput = await recordProbeInput(320, 240, RECORD_SECONDS)
  status(`  got ${highInput.width}x${highInput.height}, ${highInput.chunks.length} chunks`)

  status("recording low-res clip (160x120)...")
  const lowInput = await recordProbeInput(160, 120, RECORD_SECONDS)
  status(`  got ${lowInput.width}x${lowInput.height}, ${lowInput.chunks.length} chunks`)

  status("M1: concurrent decoder ceiling...")
  const decoderCeiling = await measureDecoderCeiling(highInput, MAX_DECODERS)
  status(`  ceiling=${decoderCeiling.ceiling} (${decoderCeiling.stoppedBy})`)

  status("M2: reset/reconfigure cost...")
  const reconfigure = await measureReconfigureCost(highInput, RECONFIGURE_ITERATIONS)
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
  const highUpload = await measureUploadCost(highInput, UPLOAD_ITERATIONS)
  status(`  mean=${highUpload.meanMs.toFixed(3)}ms`)

  status("M4: texImage2D upload cost (low-res)...")
  const lowUpload = await measureUploadCost(lowInput, UPLOAD_ITERATIONS)
  status(`  mean=${lowUpload.meanMs.toFixed(3)}ms`)

  const result: ProbeResult = {
    device: {
      userAgent: navigator.userAgent,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    },
    highRes: {
      input: dims(highInput),
      throughput: highThroughput,
      upload: highUpload,
    },
    lowRes: {
      input: dims(lowInput),
      throughput: lowThroughput,
      upload: lowUpload,
    },
    decoderCeiling,
    reconfigure,
  }
  status("done.")
  console.log(`${RESULT_PREFIX} ${JSON.stringify(result)}`)
  statusElement.textContent += `\n${JSON.stringify(result, null, 2)}\n`
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  console.error("[device-probe] failed", error)
})
