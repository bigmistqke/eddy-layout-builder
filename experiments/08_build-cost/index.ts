// build-cost — how does atlas build time scale with clip length?
//
// 05/07 measured ~10-15s to composite a 6s clip — ~2x slower than
// realtime. If that ratio is constant (build is per-frame work, so it
// should be), a 3-5 min song's composite takes 6-10 min to build, which
// breaks the hybrid's "build ≪ take" assumption. But the exact slope —
// build-seconds per second-of-content — is the single number that
// decides whether a chunked/pipelined rebuild can keep up.
//
// This records clips of several lengths, composites each into the same
// atlas (fixed N), and reports build time + the build-rate ratio. A flat
// ratio across durations confirms linearity and pins the slope.

import { composite } from "../harness/composite"
import { recordProbeInput } from "../harness/input"
import { reportResult, status } from "../harness/report"

const params = {
  captureResolution: { width: 1280, height: 720 },
  atlasResolution: { width: 1080, height: 1965 },
  // Fixed grid — the atlas frame size is constant, so N shouldn't affect
  // build rate; 16 is a representative mid grid.
  gridN: 16,
  // Clip lengths to sweep, in seconds. A first run crashed Chrome (OOM)
  // compositing a 16s clip in one pass — itself a finding: single-pass
  // composite has a memory ceiling. Kept to lengths that complete.
  durations: [3, 6, 9],
}

interface DurationResult {
  durationSeconds: number
  sourceChunks: number
  atlas: string
  compositeMs: number
  /** build-seconds per second-of-content — >1 means slower than realtime. */
  buildRateVsRealtime: number
}

async function measureDuration(durationSeconds: number): Promise<DurationResult> {
  status(`recording ${durationSeconds}s clip...`)
  const source = await recordProbeInput(
    params.captureResolution.width,
    params.captureResolution.height,
    durationSeconds,
  )
  const side = Math.sqrt(params.gridN)
  status(`  got ${source.chunks.length} chunks — compositing ${side}×${side} atlas...`)
  const { output: atlas, compositeMs } = await composite(
    source,
    side,
    side,
    params.atlasResolution.width,
    params.atlasResolution.height,
  )
  const buildRateVsRealtime = compositeMs / 1000 / durationSeconds
  status(
    `  ${durationSeconds}s → built in ${compositeMs.toFixed(0)}ms (${buildRateVsRealtime.toFixed(2)}× realtime)`,
  )
  return {
    durationSeconds,
    sourceChunks: source.chunks.length,
    atlas: `${atlas.width}x${atlas.height}`,
    compositeMs,
    buildRateVsRealtime,
  }
}

async function run(): Promise<void> {
  const durations: DurationResult[] = []
  for (const d of params.durations) {
    durations.push(await measureDuration(d))
  }
  status("done.")
  reportResult("build-cost", params, { durations })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("build-cost", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
