// container-aligned-atlases — does K=4's sub-atlas finding hold when K
// is larger and sub-atlas sizes are heterogeneous (the production
// shape, one sub-atlas per leaf container in eddy's layout tree)?
//
// 10 used a fixed 4×4 geometric split into 4 quadrants. The real
// invalidation boundary is per leaf container — K = number of leaf
// containers, sizes vary with layout. This sweeps a few realistic
// layouts (16 cell-units total) and confirms (or fails) the
// architecture at K ∈ {4, 6, 8}.

import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from "mediabunny"
import { wait } from "../../src/utils"
import { composite } from "../harness/composite"
import { recordProbeInput, type ProbeInput } from "../harness/input"
import { reportResult, status } from "../harness/report"

interface ContainerSpec {
  /** Cells within this container (e.g. 2×2 means a 4-cell container). */
  cols: number
  rows: number
  /** Container's share of the viewport (0..1 each). Cell-units / total. */
  fractionWidth: number
  fractionHeight: number
}

interface LayoutSpec {
  name: string
  containers: ContainerSpec[]
}

const params = {
  captureResolution: { width: 1280, height: 720 },
  // CSS-pixel atlas, matching 10's verdict (sweet spot: no visible blur,
  // contention budget comfortable).
  atlasResolution: { width: 540, height: 983 },
  // All layouts cover the same 16-cell viewport so totals are
  // comparable. Fraction values are share of viewport area.
  layouts: [
    // K=4 regression — reproduces 10's K=4 numbers. All containers 2×2,
    // each 1/4 viewport.
    {
      name: "4-uniform",
      containers: [
        { cols: 2, rows: 2, fractionWidth: 0.5, fractionHeight: 0.5 },
        { cols: 2, rows: 2, fractionWidth: 0.5, fractionHeight: 0.5 },
        { cols: 2, rows: 2, fractionWidth: 0.5, fractionHeight: 0.5 },
        { cols: 2, rows: 2, fractionWidth: 0.5, fractionHeight: 0.5 },
      ],
    },
    // K=6 — mix of 2×2 (4 cells) and 2×1 (2 cells) containers.
    // Totals 16 cells across 6 containers.
    {
      name: "6-mixed",
      containers: [
        { cols: 2, rows: 2, fractionWidth: 0.5, fractionHeight: 0.5 },
        { cols: 2, rows: 2, fractionWidth: 0.5, fractionHeight: 0.5 },
        { cols: 2, rows: 1, fractionWidth: 0.5, fractionHeight: 0.25 },
        { cols: 2, rows: 1, fractionWidth: 0.5, fractionHeight: 0.25 },
        { cols: 2, rows: 1, fractionWidth: 0.5, fractionHeight: 0.25 },
        { cols: 2, rows: 1, fractionWidth: 0.5, fractionHeight: 0.25 },
      ],
    },
    // K=8 — wider mix including a wide 4×1 strip and single cells.
    // Totals 16 cells across 8 containers.
    {
      name: "8-mixed",
      containers: [
        { cols: 2, rows: 2, fractionWidth: 0.5, fractionHeight: 0.5 },
        { cols: 4, rows: 1, fractionWidth: 1.0, fractionHeight: 0.25 },
        { cols: 2, rows: 1, fractionWidth: 0.5, fractionHeight: 0.25 },
        { cols: 2, rows: 1, fractionWidth: 0.5, fractionHeight: 0.25 },
        { cols: 1, rows: 1, fractionWidth: 0.25, fractionHeight: 0.25 },
        { cols: 1, rows: 1, fractionWidth: 0.25, fractionHeight: 0.25 },
        { cols: 1, rows: 1, fractionWidth: 0.25, fractionHeight: 0.25 },
        { cols: 1, rows: 1, fractionWidth: 0.25, fractionHeight: 0.25 },
      ],
    },
  ] satisfies LayoutSpec[],
  recordSeconds: 4,
  runSeconds: 4,
  maxQueue: 8,
  realtimeFps: 28,
}

interface BuildResponse {
  compositeMs: number
  width: number
  height: number
}

function rebuildInWorker(source: ProbeInput, spec: ContainerSpec): {
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
    source,
    cols: spec.cols,
    rows: spec.rows,
    width: Math.round(params.atlasResolution.width * spec.fractionWidth),
    height: Math.round(params.atlasResolution.height * spec.fractionHeight),
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

async function runOneDecoder(input: ProbeInput, deadline: number): Promise<number> {
  let decoded = 0
  const decoder = new VideoDecoder({
    output(frame) {
      decoded++
      frame.close()
    },
    error() {},
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

interface PlaybackPass {
  perDecoderFps: number[]
  minFps: number
  aggregateFps: number
}

async function runPlaybackPass(subAtlases: ProbeInput[], runSeconds: number): Promise<PlaybackPass> {
  const deadline = performance.now() + runSeconds * 1000
  const start = performance.now()
  const counts = await Promise.all(subAtlases.map(input => runOneDecoder(input, deadline)))
  const elapsed = (performance.now() - start) / 1000
  const perDecoderFps = counts.map(count => count / elapsed)
  return {
    perDecoderFps,
    minFps: Math.min(...perDecoderFps),
    aggregateFps: perDecoderFps.reduce((sum, fps) => sum + fps, 0),
  }
}

interface ContendedPass {
  captureFrames: number
  captureBytes: number
  perDecoderFps: number[]
  minFps: number
  buildMs: number
  buildRateVsRealtime: number
  buildCompletedInWindow: boolean
}

async function runContendedPass(
  subAtlases: ProbeInput[],
  source: ProbeInput,
  rebuildSpec: ContainerSpec,
  runSeconds: number,
): Promise<ContendedPass> {
  const deadline = performance.now() + runSeconds * 1000
  const buildStart = performance.now()
  const build = rebuildInWorker(source, rebuildSpec)
  let buildResponse: BuildResponse | null = null
  let buildCompletedInWindow = false
  build.done.then(response => {
    buildResponse = response
    if (performance.now() <= deadline) {
      buildCompletedInWindow = true
    }
  })
  const decodeStart = performance.now()
  const [capture, counts] = await Promise.all([
    captureForSeconds(runSeconds),
    Promise.all(subAtlases.map(input => runOneDecoder(input, deadline))),
  ])
  const decodeElapsed = (performance.now() - decodeStart) / 1000
  const perDecoderFps = counts.map(count => count / decodeElapsed)
  if (buildResponse === null) {
    buildResponse = await build.done
  }
  build.terminate()
  const buildWallClock = (performance.now() - buildStart) / 1000
  return {
    captureFrames: capture.frames,
    captureBytes: capture.blobBytes,
    perDecoderFps,
    minFps: Math.min(...perDecoderFps),
    buildMs: buildResponse.compositeMs,
    buildRateVsRealtime: buildWallClock / params.recordSeconds,
    buildCompletedInWindow,
  }
}

interface LayoutResult {
  layout: string
  k: number
  containers: Array<{ cols: number; rows: number; width: number; height: number; prebuildMs: number }>
  largestSubAtlas: { cols: number; rows: number; width: number; height: number }
  baselinePlayback: PlaybackPass & { realtimeOk: boolean }
  contended: ContendedPass & { realtimeOk: boolean }
}

async function measureLayout(source: ProbeInput, layout: LayoutSpec): Promise<LayoutResult> {
  status(`layout=${layout.name} (K=${layout.containers.length}): building sub-atlases...`)
  const subAtlases: ProbeInput[] = []
  const containerResults: LayoutResult["containers"] = []
  for (const [index, spec] of layout.containers.entries()) {
    const width = Math.round(params.atlasResolution.width * spec.fractionWidth)
    const height = Math.round(params.atlasResolution.height * spec.fractionHeight)
    const { output, compositeMs } = await composite(source, spec.cols, spec.rows, width, height)
    subAtlases.push(output)
    containerResults.push({
      cols: spec.cols,
      rows: spec.rows,
      width: output.width,
      height: output.height,
      prebuildMs: compositeMs,
    })
    status(
      `  C${index + 1}: ${spec.cols}×${spec.rows} → ${output.width}x${output.height}, built ${compositeMs.toFixed(0)}ms`,
    )
  }

  // The worst-case invalidation: rebuild the largest container (by
  // pixel area). Smaller rebuilds are strictly cheaper.
  const largestIndex = layout.containers.reduce(
    (best, spec, index, all) =>
      spec.fractionWidth * spec.fractionHeight >
      all[best].fractionWidth * all[best].fractionHeight
        ? index
        : best,
    0,
  )
  const largestSpec = layout.containers[largestIndex]

  status(`layout=${layout.name}: BASELINE — ${subAtlases.length} concurrent decoders...`)
  const baseline = await runPlaybackPass(subAtlases, params.runSeconds)
  status(`  baseline: min ${baseline.minFps.toFixed(1)}fps, aggregate ${baseline.aggregateFps.toFixed(1)}fps`)

  status(
    `layout=${layout.name}: CONTENDED — capture + ${subAtlases.length} decoders + worker rebuilds largest (${largestSpec.cols}×${largestSpec.rows})...`,
  )
  const contended = await runContendedPass(subAtlases, source, largestSpec, params.runSeconds)
  status(
    `  contended: cap ${contended.captureFrames}f, min ${contended.minFps.toFixed(1)}fps, ` +
      `build ${contended.buildMs.toFixed(0)}ms (${contended.buildRateVsRealtime.toFixed(2)}× realtime), ` +
      `finishedInWindow=${contended.buildCompletedInWindow}`,
  )

  return {
    layout: layout.name,
    k: layout.containers.length,
    containers: containerResults,
    largestSubAtlas: {
      cols: largestSpec.cols,
      rows: largestSpec.rows,
      width: containerResults[largestIndex].width,
      height: containerResults[largestIndex].height,
    },
    baselinePlayback: { ...baseline, realtimeOk: baseline.minFps >= params.realtimeFps },
    contended: { ...contended, realtimeOk: contended.minFps >= params.realtimeFps },
  }
}

async function run(): Promise<void> {
  status(`recording source clip (${params.recordSeconds}s)...`)
  const source = await recordProbeInput(
    params.captureResolution.width,
    params.captureResolution.height,
    params.recordSeconds,
  )
  status(`  got ${source.width}x${source.height}, ${source.chunks.length} chunks`)

  const layouts: LayoutResult[] = []
  for (const layout of params.layouts) {
    layouts.push(await measureLayout(source, layout))
  }
  status("done.")
  reportResult("container-aligned-atlases", params, { layouts })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("container-aligned-atlases", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
