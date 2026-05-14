// grid-streaming-transcoded — the corrected grid-streaming experiment.
//
// 03_grid-streaming recorded each cell directly from the camera, but the
// camera only offers a few discrete sensor modes — it won't hand back a
// 270×491 stream just because you asked. So 03's cross-N comparison was
// confounded by resolution.
//
// This records ONCE at capture resolution, then transcodes (downscales +
// re-encodes, snapped to 16-px macroblock alignment) to each grid's true
// cell size — a step a real streaming pipeline needs anyway — and runs N
// decoders on the transcoded clip concurrently. It isolates the question
// decoder-pools left ambiguous: is the bottleneck per-stream OVERHEAD
// (fixed per decoder → N small streams still bad → composite wins) or
// pixel BANDWIDTH (∝ pixels → N small streams summing to a viewport are
// fine → streaming works)? — and it measures the transcode cost itself.

import { recordProbeInput, type ProbeInput } from "../harness/input"
import { reportResult, status } from "../harness/report"
import { transcode } from "../harness/transcode"
import { wait } from "../../src/utils"

const params = {
  // Requested capture resolution — the camera clamps to its nearest
  // sensor mode; everything below is transcoded down from whatever it
  // actually gives.
  captureResolution: { width: 1280, height: 720 },
  // The A15's screen in device pixels (~384×699 CSS × ~2.8 dpr).
  totalResolution: { width: 1080, height: 1965 },
  // Square grids: cell = total / √N per axis.
  gridSizes: [4, 9, 16, 25],
  recordSeconds: 6,
  runSeconds: 6,
  maxQueue: 8,
  /** Per-decoder fps at/above this counts as keeping up with realtime. */
  realtimeFps: 28,
}

/** Decode `input`'s chunks on one decoder, looping until `deadline`,
 *  and resolve with the number of frames decoded. */
async function runOneDecoder(input: ProbeInput, deadline: number): Promise<number> {
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
      while (decoder.decodeQueueSize > params.maxQueue) {
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
    `  transcoded in ${transcodeMs.toFixed(0)}ms (${cellClip.chunks.length} chunks) — running ${n} decoders...`,
  )

  const deadline = performance.now() + params.runSeconds * 1000
  const start = performance.now()
  const counts = await Promise.all(
    Array.from({ length: n }, () => runOneDecoder(cellClip, deadline)),
  )
  const elapsedSeconds = (performance.now() - start) / 1000

  const perDecoderFps = counts.map(count => count / elapsedSeconds)
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
  reportResult("grid-streaming-transcoded", params, {
    source: { requested: `${source.requestedWidth}x${source.requestedHeight}`, actual: `${source.width}x${source.height}` },
    grids,
  })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("grid-streaming-transcoded", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
