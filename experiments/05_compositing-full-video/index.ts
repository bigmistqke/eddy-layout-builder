// compositing-full-video — does one atlas decode beat N small streams?
//
// 03/04 showed streaming N independent decoders sustains realtime only
// at N≈4 — per-decode/per-stream overhead is the wall. The composite's
// pitch: pack all N cells into ONE viewport-sized frame and decode that
// single stream — paying the per-decode overhead once, regardless of N.
//
// This builds an atlas (cols×rows grid of the source clip, one
// re-encoded stream) at viewport resolution for each N, decodes that one
// stream, and measures fps. The fair comparison: that fps IS the fps for
// ALL N cells — set it against 04's per-decoder min fps for the same N.
// The atlas goes through VideoEncoder too, so it carries the same
// re-encode tax 04 surfaced — this is a like-for-like fight.

import { composite } from "../harness/composite"
import { recordProbeInput, type ProbeInput } from "../harness/input"
import { reportResult, status } from "../harness/report"
import { wait } from "../../src/utils"

const params = {
  // Camera clamps to its nearest sensor mode; the atlas is built from
  // whatever it gives.
  captureResolution: { width: 1280, height: 720 },
  // The atlas frame = the A15's screen (~384×699 CSS × ~2.8 dpr). One
  // decode of this carries all N cells.
  atlasResolution: { width: 1080, height: 1965 },
  // Square grids — matches 04_grid-streaming-transcoded for head-to-head.
  gridSizes: [4, 9, 16, 25],
  recordSeconds: 6,
  runSeconds: 6,
  maxQueue: 8,
  /** fps at/above this counts as keeping up with realtime. */
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
  atlas: { target: string; actual: string }
  compositeMs: number
  /** fps of the single atlas decode — i.e. the fps for ALL N cells. */
  fps: number
  realtimeOk: boolean
}

async function measureGrid(source: ProbeInput, n: number): Promise<GridResult> {
  const side = Math.sqrt(n)
  status(`N=${n}: compositing ${side}×${side} atlas at ${params.atlasResolution.width}x${params.atlasResolution.height}...`)
  const { output: atlas, compositeMs } = await composite(
    source,
    side,
    side,
    params.atlasResolution.width,
    params.atlasResolution.height,
  )
  status(
    `  atlas ${atlas.width}x${atlas.height}, ${atlas.chunks.length} chunks, built in ${compositeMs.toFixed(0)}ms — decoding...`,
  )

  const deadline = performance.now() + params.runSeconds * 1000
  const start = performance.now()
  const count = await runOneDecoder(atlas, deadline)
  const elapsedSeconds = (performance.now() - start) / 1000

  const fps = count / elapsedSeconds
  const realtimeOk = fps >= params.realtimeFps
  status(`  N=${n}: ${fps.toFixed(1)} fps  realtimeOk=${realtimeOk}`)
  return {
    n,
    atlas: {
      target: `${params.atlasResolution.width}x${params.atlasResolution.height}`,
      actual: `${atlas.width}x${atlas.height}`,
    },
    compositeMs,
    fps,
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
  reportResult("compositing-full-video", params, {
    source: { requested: `${source.requestedWidth}x${source.requestedHeight}`, actual: `${source.width}x${source.height}` },
    grids,
  })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("compositing-full-video", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
