// sub-atlas-rebuild — can splitting the composite into K sub-atlases
// make "rebuild during recording" actually fit?
//
// 09 found a full-atlas rebuild costs ~2.5× realtime under capture +
// playback contention. WebCodecs can't update a sub-rect of a frame, so
// the only way to make rebuild cheaper is to split the atlas into K
// pieces — change one cell, re-encode one sub-atlas. Build cost
// per change becomes ~1/K of full-atlas. Trade-off: playback now needs
// K concurrent decoders.
//
// This measures both halves at fixed N=16, sweeping K ∈ {1, 2, 4}.

import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from "mediabunny"
import { wait } from "../../src/utils"
import { composite } from "../harness/composite"
import { recordProbeInput, type ProbeInput } from "../harness/input"
import { reportResult, status } from "../harness/report"

const params = {
  captureResolution: { width: 1280, height: 720 },
  atlasResolution: { width: 1080, height: 1965 },
  // Fixed cell count — the user's grid. K varies how it's packed.
  totalCells: 16,
  // K = sub-atlas count. K=1 reproduces 09's baseline; K=4 is the
  // natural target (1/4 build cost, 4 streams already known realtime
  // per 04). K=8 deferred — that's pure streaming, and 04 said it walls.
  subAtlasCounts: [1, 2, 4],
  recordSeconds: 4,
  runSeconds: 4,
  maxQueue: 8,
  realtimeFps: 28,
}

interface SubAtlasSpec {
  /** (cols, rows) within this sub-atlas — together K spec.cols*spec.rows = totalCells. */
  cols: number
  rows: number
  /** Output dimensions for this sub-atlas — together they pack into atlasResolution. */
  width: number
  height: number
}

/** Decide the K sub-atlas geometries for a given K. Each sub-atlas
 *  carries the same number of cells, all at the same per-cell pixel
 *  size — so total atlas pixels are independent of K. */
function subAtlasSpecs(k: number): SubAtlasSpec[] {
  const totalSide = Math.sqrt(params.totalCells)
  if (totalSide !== Math.floor(totalSide)) {
    throw new Error("sub-atlas: totalCells must be a square")
  }
  const fullCols = totalSide
  const fullRows = totalSide
  // Split the full grid horizontally first, then vertically, until we
  // have K pieces. Works for K ∈ {1, 2, 4} on a 4x4 grid: 1×1 of 4×4,
  // 1×2 of 4×2, 2×2 of 2×2.
  let pieceCols = fullCols
  let pieceRows = fullRows
  let pieces = 1
  while (pieces < k) {
    if (pieceRows >= pieceCols) {
      pieceRows = pieceRows / 2
    } else {
      pieceCols = pieceCols / 2
    }
    pieces *= 2
  }
  if (pieceCols !== Math.floor(pieceCols) || pieceRows !== Math.floor(pieceRows)) {
    throw new Error(`sub-atlas: K=${k} doesn't divide ${fullCols}×${fullRows} cleanly`)
  }
  const width = (params.atlasResolution.width * pieceCols) / fullCols
  const height = (params.atlasResolution.height * pieceRows) / fullRows
  const specs: SubAtlasSpec[] = []
  for (let i = 0; i < k; i++) {
    specs.push({ cols: pieceCols, rows: pieceRows, width, height })
  }
  return specs
}

interface BuildResponse {
  compositeMs: number
  width: number
  height: number
}

function rebuildOneSubAtlasInWorker(source: ProbeInput, spec: SubAtlasSpec): {
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
  worker.postMessage({ source, cols: spec.cols, rows: spec.rows, width: spec.width, height: spec.height })
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

/** Decode `input`'s chunks on one decoder, looping until `deadline`. */
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

async function runPlaybackPass(subAtlases: ProbeInput[], runSeconds: number): Promise<{
  perDecoderFps: number[]
  minFps: number
  aggregateFps: number
}> {
  const deadline = performance.now() + runSeconds * 1000
  const start = performance.now()
  const counts = await Promise.all(subAtlases.map(input => runOneDecoder(input, deadline)))
  const elapsedSeconds = (performance.now() - start) / 1000
  const perDecoderFps = counts.map(count => count / elapsedSeconds)
  return {
    perDecoderFps,
    minFps: Math.min(...perDecoderFps),
    aggregateFps: perDecoderFps.reduce((sum, fps) => sum + fps, 0),
  }
}

interface ContendedPassResult {
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
  rebuildSpec: SubAtlasSpec,
  runSeconds: number,
): Promise<ContendedPassResult> {
  const deadline = performance.now() + runSeconds * 1000
  const buildStart = performance.now()
  const build = rebuildOneSubAtlasInWorker(source, rebuildSpec)
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
  const decodeElapsedSeconds = (performance.now() - decodeStart) / 1000
  const perDecoderFps = counts.map(count => count / decodeElapsedSeconds)
  if (buildResponse === null) {
    buildResponse = await build.done
  }
  build.terminate()
  const buildWallClockSeconds = (performance.now() - buildStart) / 1000
  return {
    captureFrames: capture.frames,
    captureBytes: capture.blobBytes,
    perDecoderFps,
    minFps: Math.min(...perDecoderFps),
    buildMs: buildResponse.compositeMs,
    buildRateVsRealtime: buildWallClockSeconds / params.recordSeconds,
    buildCompletedInWindow,
  }
}

interface KResult {
  k: number
  subAtlas: { width: number; height: number; cells: string }
  prebuildMsEach: number[]
  baselinePlayback: {
    perDecoderFps: number[]
    minFps: number
    aggregateFps: number
    realtimeOk: boolean
  }
  contended: ContendedPassResult & { realtimeOk: boolean }
}

async function measureK(source: ProbeInput, k: number): Promise<KResult> {
  status(`K=${k}: building ${k} sub-atlases...`)
  const specs = subAtlasSpecs(k)
  const subAtlases: ProbeInput[] = []
  const prebuildMsEach: number[] = []
  for (const [index, spec] of specs.entries()) {
    const { output, compositeMs } = await composite(source, spec.cols, spec.rows, spec.width, spec.height)
    subAtlases.push(output)
    prebuildMsEach.push(compositeMs)
    status(`  sub-atlas ${index + 1}/${k}: ${output.width}x${output.height}, built ${compositeMs.toFixed(0)}ms`)
  }

  status(`K=${k}: BASELINE playback — ${k} concurrent decoders, no build, no capture...`)
  const baseline = await runPlaybackPass(subAtlases, params.runSeconds)
  status(
    `  baseline: min ${baseline.minFps.toFixed(1)}fps, aggregate ${baseline.aggregateFps.toFixed(1)}fps`,
  )

  status(`K=${k}: CONTENDED — capture + ${k} decoders + worker rebuilds 1 sub-atlas...`)
  const contended = await runContendedPass(subAtlases, source, specs[0], params.runSeconds)
  status(
    `  contended: capture ${contended.captureFrames}f, min ${contended.minFps.toFixed(1)}fps, ` +
      `build ${contended.buildMs.toFixed(0)}ms (${contended.buildRateVsRealtime.toFixed(2)}× realtime), ` +
      `finishedInWindow=${contended.buildCompletedInWindow}`,
  )

  return {
    k,
    subAtlas: {
      width: specs[0].width,
      height: specs[0].height,
      cells: `${specs[0].cols}×${specs[0].rows}`,
    },
    prebuildMsEach,
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

  const ks: KResult[] = []
  for (const k of params.subAtlasCounts) {
    ks.push(await measureK(source, k))
  }
  status("done.")
  reportResult("sub-atlas-rebuild", params, { ks })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("sub-atlas-rebuild", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
