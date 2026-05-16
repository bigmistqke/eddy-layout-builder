// concurrent-build — can the atlas build run during a recording session
// without degrading the capture or the loop playback?
//
// 08 said build is ~1.2× realtime, which naively breaks the
// "stop recording → take is in the loop" UX. But the recording window is
// itself ≥ song-length of committed device time, during which the user
// is already paying for capture + playback. If the build of the existing
// take-set can hide *inside* that window, the baking beat disappears.
//
// This runs three workloads concurrently — camera capture, atlas
// playback, and a Worker atlas build — and compares against a baseline
// without the build. Each of the three must hold independently for the
// flow to feel free.

import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from "mediabunny"
import { wait } from "../../src/utils"
import { composite } from "../harness/composite"
import { recordProbeInput, type ProbeInput } from "../harness/input"
import { reportResult, status } from "../harness/report"

const params = {
  captureResolution: { width: 1280, height: 720 },
  atlasResolution: { width: 1080, height: 1965 },
  // Grids where the atlas is required (N≤4 streams natively per 04).
  // First [9, 16] × 6s OOM-crashed Chrome (three concurrent workloads +
  // a pre-baked atlas + the worker's build buffer exceed the A15's tab
  // budget). N=9 × 4s holds; trying N=16 × 4s next with the tighter
  // budget — fast crash detection (Inspector.targetCrashed) means an
  // OOM at N=16 fails in seconds, not the old 3-min timeout.
  gridSizes: [9, 16],
  // Source clip length. 08 found single-pass composite OOMs past ~9 s
  // on its own; this experiment runs a second composite *concurrently
  // with* capture + playback decode, so the safe envelope is tighter.
  recordSeconds: 4,
  runSeconds: 4,
  maxQueue: 8,
}

interface CaptureSample {
  frames: number
  blobBytes: number
}

/** MediaRecorder + post-stop demux. The frame count is the integrity
 *  signal: a drop under contention means the encoder is starving. */
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
    throw new Error("captureForSeconds: recording has no video track")
  }
  const sink = new EncodedPacketSink(videoTrack)
  let frames = 0
  for await (const _packet of sink.packets()) {
    frames++
  }
  return { frames, blobBytes: blob.size }
}

/** Decode the atlas in a loop until `deadline`. Returns decoded fps. */
async function playbackForDeadline(atlas: ProbeInput, deadline: number): Promise<number> {
  const start = performance.now()
  let decoded = 0
  const decoder = new VideoDecoder({
    output(frame) {
      decoded++
      frame.close()
    },
    error() {
      // a dead decoder just stops counting — surfaces as low fps
    },
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
  return decoded / ((performance.now() - start) / 1000)
}

interface BuildResponse {
  compositeMs: number
  atlas: { width: number; height: number }
}

function startBuildInWorker(
  source: ProbeInput,
  n: number,
): { done: Promise<BuildResponse>; terminate(): void } {
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
    n,
    atlasWidth: params.atlasResolution.width,
    atlasHeight: params.atlasResolution.height,
  })
  return {
    done: promise,
    terminate() {
      worker.terminate()
    },
  }
}

interface PassResult {
  captureFrames: number
  captureBytes: number
  playbackFps: number
}

interface ContendedPassResult extends PassResult {
  buildCompletedInWindow: boolean
  buildMs: number
  buildRateVsRealtime: number
  atlas: string
}

async function runPass(playbackAtlas: ProbeInput, runSeconds: number): Promise<PassResult> {
  const deadline = performance.now() + runSeconds * 1000
  const [capture, playbackFps] = await Promise.all([
    captureForSeconds(runSeconds),
    playbackForDeadline(playbackAtlas, deadline),
  ])
  return {
    captureFrames: capture.frames,
    captureBytes: capture.blobBytes,
    playbackFps,
  }
}

async function runContendedPass(
  playbackAtlas: ProbeInput,
  buildSource: ProbeInput,
  n: number,
  runSeconds: number,
): Promise<ContendedPassResult> {
  const deadline = performance.now() + runSeconds * 1000
  const build = startBuildInWorker(buildSource, n)
  let buildResponse: BuildResponse | null = null
  let buildCompletedInWindow = false
  const buildStart = performance.now()
  build.done.then(response => {
    buildResponse = response
    if (performance.now() <= deadline) {
      buildCompletedInWindow = true
    }
  })
  const [capture, playbackFps] = await Promise.all([
    captureForSeconds(runSeconds),
    playbackForDeadline(playbackAtlas, deadline),
  ])
  // Let the build finish so we can report its true ms, even if it ran
  // past the recording window.
  if (buildResponse === null) {
    buildResponse = await build.done
  }
  build.terminate()
  const buildMs = buildResponse.compositeMs
  const buildWallClock = (performance.now() - buildStart) / 1000
  return {
    captureFrames: capture.frames,
    captureBytes: capture.blobBytes,
    playbackFps,
    buildCompletedInWindow,
    buildMs,
    buildRateVsRealtime: buildWallClock / params.recordSeconds,
    atlas: `${buildResponse.atlas.width}x${buildResponse.atlas.height}`,
  }
}

interface GridResult {
  n: number
  prebakedAtlas: string
  prebakeMs: number
  baseline: PassResult
  contended: ContendedPassResult
}

async function measureGrid(n: number): Promise<GridResult> {
  status(`N=${n}: recording source clip (${params.recordSeconds}s)...`)
  const source = await recordProbeInput(
    params.captureResolution.width,
    params.captureResolution.height,
    params.recordSeconds,
  )
  status(`  got ${source.width}x${source.height}, ${source.chunks.length} chunks`)

  const side = Math.sqrt(n)
  status(`N=${n}: pre-building atlas (the 'already-baked' state)...`)
  const prebake = await composite(
    source,
    side,
    side,
    params.atlasResolution.width,
    params.atlasResolution.height,
  )
  status(`  prebaked ${prebake.output.width}x${prebake.output.height} in ${prebake.compositeMs.toFixed(0)}ms`)

  status(`N=${n}: BASELINE — capture + playback (no concurrent build)...`)
  const baseline = await runPass(prebake.output, params.runSeconds)
  status(
    `  baseline: capture ${baseline.captureFrames}f, playback ${baseline.playbackFps.toFixed(1)}fps`,
  )

  status(`N=${n}: CONTENDED — capture + playback + worker build...`)
  const contended = await runContendedPass(prebake.output, source, n, params.runSeconds)
  status(
    `  contended: capture ${contended.captureFrames}f, playback ${contended.playbackFps.toFixed(1)}fps, ` +
      `build ${contended.buildMs.toFixed(0)}ms (${contended.buildRateVsRealtime.toFixed(2)}× realtime), ` +
      `finishedInWindow=${contended.buildCompletedInWindow}`,
  )

  return {
    n,
    prebakedAtlas: `${prebake.output.width}x${prebake.output.height}`,
    prebakeMs: prebake.compositeMs,
    baseline,
    contended,
  }
}

async function run(): Promise<void> {
  const grids: GridResult[] = []
  for (const n of params.gridSizes) {
    grids.push(await measureGrid(n))
  }
  status("done.")
  reportResult("concurrent-build", params, { grids })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("concurrent-build", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
