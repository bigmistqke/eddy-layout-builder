// decoder-pools — is the decoder pool actually dead?
//
// raw-capability showed the A15 *instantiates* many VideoDecoders, but
// each only decoded one keyframe. The real question for streaming
// playback is sustained concurrent decode: can K decoders ALL decode
// their own stream continuously, at once, at realistic resolution, and
// each keep up with ~30 fps realtime?
//
// This runs K decoders in parallel, each looping a recorded 720p clip
// for `runSeconds` of wall-clock, and reports the per-decoder sustained
// fps. If every decoder holds ~30 fps, the pool is alive for N = K.
// (Time-slicing one decoder across N > K cells is a later experiment.)

import { recordProbeInput, type ProbeInput } from "../harness/input"
import { reportResult, status } from "../harness/report"
import { wait } from "../../src/utils"

const params = {
  poolSize: 8,
  recordSeconds: 6,
  runSeconds: 8,
  resolution: { width: 1280, height: 720 },
  // Soft cap on a decoder's pending-decode queue — feed past this and a
  // slow decoder just buffers unboundedly instead of revealing its real
  // throughput.
  maxQueue: 8,
  /** Per-decoder fps at/above this counts as "keeping up with realtime". */
  realtimeFps: 28,
}

/** Decode `input`'s chunks on one decoder, looping (reset → reconfigure →
 *  re-feed from the keyframe) until `deadline`, and resolve with the
 *  number of frames decoded. */
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
    // Loop the clip: a fresh keyframe start for the next pass.
    decoder.reset()
    decoder.configure(input.config)
  }
  decoder.close()
  return decoded
}

async function run(): Promise<void> {
  status(`recording ${params.resolution.width}x${params.resolution.height} clip...`)
  const input = await recordProbeInput(
    params.resolution.width,
    params.resolution.height,
    params.recordSeconds,
  )
  status(`  got ${input.width}x${input.height}, ${input.chunks.length} chunks`)

  status(`running ${params.poolSize} decoders concurrently for ${params.runSeconds}s...`)
  const deadline = performance.now() + params.runSeconds * 1000
  const start = performance.now()
  const counts = await Promise.all(
    Array.from({ length: params.poolSize }, () => runOneDecoder(input, deadline)),
  )
  const elapsedSeconds = (performance.now() - start) / 1000

  const perDecoderFps = counts.map(count => count / elapsedSeconds)
  const minFps = Math.min(...perDecoderFps)
  const aggregateFps = perDecoderFps.reduce((sum, fps) => sum + fps, 0)
  const realtimeOk = minFps >= params.realtimeFps

  for (let i = 0; i < perDecoderFps.length; i++) {
    status(`  decoder ${i}: ${perDecoderFps[i].toFixed(1)} fps`)
  }
  status(`min=${minFps.toFixed(1)} fps  aggregate=${aggregateFps.toFixed(1)} fps  realtimeOk=${realtimeOk}`)
  status("done.")

  reportResult("decoder-pools", params, {
    input: { requested: `${input.requestedWidth}x${input.requestedHeight}`, actual: `${input.width}x${input.height}` },
    elapsedSeconds,
    perDecoderFps,
    minFps,
    aggregateFps,
    realtimeOk,
  })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("decoder-pools", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
