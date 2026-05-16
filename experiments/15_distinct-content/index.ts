// distinct-content — does K=4 sub-atlas survive when each cell holds a
// DIFFERENT clip (higher entropy, no encoder deduplication)?
//
// Two passes, same contention shape as 11's K=4 contended:
//   identical: sub-atlas tiles ONE clip into 4 cells (matches 11)
//   distinct:  sub-atlas tiles 4 different clips, one per cell
// Compare every metric. If atlasFps holds and buildRate only modestly
// rises, K=4 verdict survives.

import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from "mediabunny"
import { wait } from "../../src/utils"
import { composite } from "../harness/composite"
import { recordProbeInput, type ProbeInput } from "../harness/input"
import { reportResult, status } from "../harness/report"
import { compositeDistinct } from "./composite-distinct"

const params = {
  captureResolution: { width: 1280, height: 720 },
  // Single sub-atlas, K=4 cells (2×2 within a viewport-quadrant) —
  // matches 10/11's K=4 case at CSS-pixel resolution.
  subAtlasResolution: { width: 270, height: 491 },
  subAtlasCols: 2,
  subAtlasRows: 2,
  recordSeconds: 4,
  runSeconds: 4,
  maxQueue: 8,
  realtimeFps: 28,
}

interface BuildResponse {
  compositeMs: number
  atlasBytes: number
  width: number
  height: number
}

function rebuildInWorker(sources: ProbeInput[]): {
  done: Promise<BuildResponse>
  terminate(): void
} {
  const worker = new Worker(new URL("./build-worker.ts", import.meta.url), { type: "module" })
  const { promise, resolve, reject } = Promise.withResolvers<BuildResponse>()
  worker.onmessage = (event: MessageEvent<BuildResponse>) => {
    resolve(event.data)
  }
  worker.onerror = error => {
    reject(error)
  }
  worker.postMessage({
    sources,
    cols: params.subAtlasCols,
    rows: params.subAtlasRows,
    width: params.subAtlasResolution.width,
    height: params.subAtlasResolution.height,
  })
  return { done: promise, terminate: () => worker.terminate() }
}

interface CaptureSample {
  frames: number
  blobBytes: number
}

async function captureForSeconds(seconds: number): Promise<CaptureSample> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: params.captureResolution.width, height: params.captureResolution.height },
    audio: true,
  })
  const mimeType = "video/webm;codecs=vp8,opus"
  const recorder = new MediaRecorder(stream, { mimeType })
  const blobParts: Blob[] = []
  recorder.ondataavailable = event => {
    if (event.data.size > 0) {
      blobParts.push(event.data)
    }
  }
  const { promise: stopped, resolve: onStopped } = Promise.withResolvers<void>()
  recorder.onstop = () => {
    onStopped()
  }
  recorder.start()
  await wait(seconds * 1000)
  recorder.stop()
  await stopped
  for (const track of stream.getTracks()) {
    track.stop()
  }
  const blob = new Blob(blobParts, { type: mimeType })
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  const videoTrack = await input.getPrimaryVideoTrack()
  if (videoTrack === null) {
    throw new Error("captureForSeconds: no video track")
  }
  const sink = new EncodedPacketSink(videoTrack)
  let frames = 0
  for await (const _packet of sink.packets()) {
    frames++
  }
  return { frames, blobBytes: blob.size }
}

async function runAtlasDecoder(atlas: ProbeInput, deadline: number): Promise<number> {
  let decoded = 0
  const decoder = new VideoDecoder({
    output(frame) {
      decoded++
      frame.close()
    },
    error() {},
  })
  decoder.configure(atlas.config)
  while (performance.now() < deadline) {
    for (const chunk of atlas.chunks) {
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
    decoder.configure(atlas.config)
  }
  decoder.close()
  return decoded
}

interface ContendedPass {
  captureFrames: number
  captureBytes: number
  atlasFps: number
  buildMs: number
  buildAtlasBytes: number
  buildRateVsRealtime: number
  buildCompletedInWindow: boolean
}

async function runContendedPass(
  decodedAtlas: ProbeInput,
  rebuildSources: ProbeInput[],
  runSeconds: number,
): Promise<ContendedPass> {
  const deadline = performance.now() + runSeconds * 1000
  const buildStart = performance.now()
  const build = rebuildInWorker(rebuildSources)
  let buildResponse: BuildResponse | null = null
  let buildCompletedInWindow = false
  build.done.then(response => {
    buildResponse = response
    if (performance.now() <= deadline) {
      buildCompletedInWindow = true
    }
  })
  const atlasStart = performance.now()
  const [capture, atlasCount] = await Promise.all([
    captureForSeconds(runSeconds),
    runAtlasDecoder(decodedAtlas, deadline),
  ])
  const atlasElapsed = (performance.now() - atlasStart) / 1000
  if (buildResponse === null) {
    buildResponse = await build.done
  }
  build.terminate()
  const buildWallClock = (performance.now() - buildStart) / 1000
  return {
    captureFrames: capture.frames,
    captureBytes: capture.blobBytes,
    atlasFps: atlasCount / atlasElapsed,
    buildMs: buildResponse.compositeMs,
    buildAtlasBytes: buildResponse.atlasBytes,
    buildRateVsRealtime: buildWallClock / params.recordSeconds,
    buildCompletedInWindow,
  }
}

interface PassResult {
  label: string
  prebuildMs: number
  atlasBytes: number
  contended: ContendedPass & { realtimeOk: boolean }
}

async function run(): Promise<void> {
  const cellCount = params.subAtlasCols * params.subAtlasRows
  status(`recording ${cellCount} distinct source clips...`)
  const clips: ProbeInput[] = []
  for (let i = 0; i < cellCount; i++) {
    status(`  recording clip ${i + 1}/${cellCount}...`)
    clips.push(
      await recordProbeInput(
        params.captureResolution.width,
        params.captureResolution.height,
        params.recordSeconds,
      ),
    )
    // Brief pause so the camera/scene differs between takes.
    await wait(300)
  }
  status(`  got ${clips.length} clips`)

  // IDENTICAL pass — tile clip 0 into 4 cells via harness/composite
  status(`IDENTICAL: building sub-atlas (clip 0 × 4)...`)
  const identical = await composite(
    clips[0],
    params.subAtlasCols,
    params.subAtlasRows,
    params.subAtlasResolution.width,
    params.subAtlasResolution.height,
  )
  const identicalBytes = identical.output.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  status(
    `  identical sub-atlas: ${identical.output.width}x${identical.output.height}, ` +
      `${identicalBytes} bytes, built ${identical.compositeMs.toFixed(0)}ms`,
  )

  status(`IDENTICAL: CONTENDED — capture + atlas decode + worker rebuild (identical)...`)
  const identicalContended = await runContendedPass(
    identical.output,
    [clips[0], clips[0], clips[0], clips[0]],
    params.runSeconds,
  )
  status(
    `  identical contended: cap ${identicalContended.captureFrames}f, ` +
      `atlasFps ${identicalContended.atlasFps.toFixed(1)}, ` +
      `build ${identicalContended.buildMs.toFixed(0)}ms (${identicalContended.buildRateVsRealtime.toFixed(2)}×, ` +
      `${identicalContended.buildAtlasBytes} bytes)`,
  )

  // DISTINCT pass — each cell holds a different clip
  status(`DISTINCT: building sub-atlas (4 different clips)...`)
  const distinct = await compositeDistinct(
    clips,
    params.subAtlasCols,
    params.subAtlasRows,
    params.subAtlasResolution.width,
    params.subAtlasResolution.height,
  )
  status(
    `  distinct sub-atlas: ${distinct.output.width}x${distinct.output.height}, ` +
      `${distinct.atlasBytes} bytes, built ${distinct.compositeMs.toFixed(0)}ms`,
  )

  status(`DISTINCT: CONTENDED — capture + atlas decode + worker rebuild (distinct)...`)
  const distinctContended = await runContendedPass(
    distinct.output,
    clips,
    params.runSeconds,
  )
  status(
    `  distinct contended: cap ${distinctContended.captureFrames}f, ` +
      `atlasFps ${distinctContended.atlasFps.toFixed(1)}, ` +
      `build ${distinctContended.buildMs.toFixed(0)}ms (${distinctContended.buildRateVsRealtime.toFixed(2)}×, ` +
      `${distinctContended.buildAtlasBytes} bytes)`,
  )

  const passes: PassResult[] = [
    {
      label: "identical",
      prebuildMs: identical.compositeMs,
      atlasBytes: identicalBytes,
      contended: {
        ...identicalContended,
        realtimeOk: identicalContended.atlasFps >= params.realtimeFps,
      },
    },
    {
      label: "distinct",
      prebuildMs: distinct.compositeMs,
      atlasBytes: distinct.atlasBytes,
      contended: {
        ...distinctContended,
        realtimeOk: distinctContended.atlasFps >= params.realtimeFps,
      },
    },
  ]
  status("done.")
  reportResult("distinct-content", params, { passes })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("distinct-content", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
