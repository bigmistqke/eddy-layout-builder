// progressive-overlap — 18 but with the production overlap shape:
// stop record → next take starts immediately, atlas rebuild runs in
// the background. Adds per-frame jank stats and per-clip integrity.

import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from "mediabunny"
import { wait } from "../../src/utils"
import type { ProbeInput } from "../harness/input"
import { reportResult, status } from "../harness/report"

const params = {
  captureResolution: { width: 1280, height: 720 },
  canvasResolution: { width: 540, height: 982 },
  takeSeconds: 6,
  stages: 9,
  // 128×232 ≈ 9:16 to match the camera's portrait aspect. Smaller
  // than 18's 270×491 so peak memory (9 stages of bitmaps in flight
  // until atlases catch up) stays bounded — 18b's first run OOM'd
  // the tab at 270×491.
  bitmapResolution: { width: 128, height: 232 },
  /** Expected camera fps for integrity checks; the device's actual
   *  capture rate seems to be ~20 not 30 on this phone (per recording
   *  artefacts in 17b's notes), so we'll derive it from clip 1's
   *  measured rate rather than assuming a target. */
  assumedFps: 30,
}

interface BitmapMessage {
  type: "bitmap"
  bitmap: ImageBitmap
}
interface DoneMessage {
  type: "done"
  bitmapsEmitted: number
}
type BitmapWorkerMessage = BitmapMessage | DoneMessage

interface AtlasBuildResponse {
  compositeMs: number
  atlasBytes: number
  atlas: ProbeInput
}

interface RecordResult {
  clip: ProbeInput
  bitmaps: ImageBitmap[]
  bitmapKeepUpRatio: number
  /** Per-frame timestamps in microseconds, from the demuxed chunks. */
  frameTimestamps: number[]
}

async function recordWithBitmaps(
  stream: MediaStream,
  seconds: number,
): Promise<RecordResult> {
  const processorCtor = (globalThis as unknown as {
    MediaStreamTrackProcessor?: new (init: { track: MediaStreamTrack }) => {
      readable: ReadableStream<VideoFrame>
    }
  }).MediaStreamTrackProcessor
  if (processorCtor === undefined) {
    throw new Error("MediaStreamTrackProcessor unavailable")
  }
  const videoTrack = stream.getVideoTracks()[0]
  const bitmapTrack = videoTrack.clone()
  const processor = new processorCtor({ track: bitmapTrack })

  const worker = new Worker(new URL("./bitmap-worker.ts", import.meta.url), { type: "module" })
  const bitmaps: ImageBitmap[] = []
  const { promise: workerDone, resolve: resolveWorkerDone } = Promise.withResolvers<DoneMessage>()
  worker.onmessage = (event: MessageEvent<BitmapWorkerMessage>) => {
    if (event.data.type === "bitmap") {
      bitmaps.push(event.data.bitmap)
    } else {
      resolveWorkerDone(event.data)
    }
  }
  worker.postMessage(
    {
      readable: processor.readable,
      bitmapWidth: params.bitmapResolution.width,
      bitmapHeight: params.bitmapResolution.height,
    },
    [processor.readable as unknown as Transferable],
  )

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
  bitmapTrack.stop()
  const doneMessage = await workerDone
  worker.terminate()

  const blob = new Blob(blobParts, { type: mimeType })
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  const recordedTrack = await input.getPrimaryVideoTrack()
  if (recordedTrack === null) {
    throw new Error("recordWithBitmaps: no video track")
  }
  const config = await recordedTrack.getDecoderConfig()
  if (config === null) {
    throw new Error("recordWithBitmaps: no decoder config")
  }
  const sink = new EncodedPacketSink(recordedTrack)
  const chunks: EncodedVideoChunk[] = []
  const frameTimestamps: number[] = []
  for await (const packet of sink.packets()) {
    const chunk = packet.toEncodedVideoChunk()
    if (chunks.length === 0 && chunk.type !== "key") {
      continue
    }
    chunks.push(chunk)
    frameTimestamps.push(chunk.timestamp)
  }
  if (chunks.length === 0) {
    throw new Error("recordWithBitmaps: no keyframe")
  }
  return {
    clip: {
      config,
      chunks,
      width: recordedTrack.codedWidth,
      height: recordedTrack.codedHeight,
      requestedWidth: params.captureResolution.width,
      requestedHeight: params.captureResolution.height,
    },
    bitmaps,
    bitmapKeepUpRatio: doneMessage.bitmapsEmitted / Math.max(1, chunks.length),
    frameTimestamps,
  }
}

interface IntegrityReport {
  framesActual: number
  framesExpected: number
  framesDropped: number
  meanIntervalMs: number
  maxIntervalMs: number
  measuredFps: number
}

function checkIntegrity(timestamps: number[], expectedSeconds: number): IntegrityReport {
  if (timestamps.length < 2) {
    return {
      framesActual: timestamps.length,
      framesExpected: 0,
      framesDropped: 0,
      meanIntervalMs: 0,
      maxIntervalMs: 0,
      measuredFps: 0,
    }
  }
  const intervals: number[] = []
  for (let i = 1; i < timestamps.length; i++) {
    intervals.push((timestamps[i] - timestamps[i - 1]) / 1000)
  }
  const meanInterval =
    intervals.reduce((a, b) => a + b, 0) / intervals.length
  const maxInterval = Math.max(...intervals)
  const measuredFps = 1000 / meanInterval
  // Drops: intervals > 1.5× the mean.
  const dropThreshold = meanInterval * 1.5
  let drops = 0
  for (const i of intervals) {
    if (i > dropThreshold) {
      drops += Math.round(i / meanInterval) - 1
    }
  }
  const framesExpected = Math.round(measuredFps * expectedSeconds)
  return {
    framesActual: timestamps.length,
    framesExpected,
    framesDropped: drops,
    meanIntervalMs: meanInterval,
    maxIntervalMs: maxInterval,
    measuredFps,
  }
}

function rebuildAtlasInWorker(clips: ProbeInput[]): {
  done: Promise<AtlasBuildResponse>
  terminate(): void
} {
  const cols = 1
  const rows = clips.length
  const cellHeight = Math.floor(params.canvasResolution.height / rows)
  const width = params.canvasResolution.width
  const height = cellHeight * rows
  const worker = new Worker(new URL("./atlas-worker.ts", import.meta.url), { type: "module" })
  const { promise, resolve, reject } = Promise.withResolvers<AtlasBuildResponse>()
  worker.onmessage = (event: MessageEvent<AtlasBuildResponse>) => {
    resolve(event.data)
  }
  worker.onerror = error => {
    reject(error)
  }
  worker.postMessage({ sources: clips, cols, rows, width, height })
  return { done: promise, terminate: () => worker.terminate() }
}

async function prewarmAtlas(atlas: ProbeInput): Promise<{
  bitmap: ImageBitmap
  decoder: VideoDecoder
  nextFrame(): Promise<VideoFrame>
}> {
  const queue: VideoFrame[] = []
  const waiters: ((frame: VideoFrame) => void)[] = []
  const decoder = new VideoDecoder({
    output(frame) {
      const waiter = waiters.shift()
      if (waiter) {
        waiter(frame)
      } else {
        queue.push(frame)
      }
    },
    error() {},
  })
  decoder.configure(atlas.config)
  function nextFrame(): Promise<VideoFrame> {
    const queued = queue.shift()
    if (queued) {
      return Promise.resolve(queued)
    }
    return new Promise<VideoFrame>(resolve => {
      waiters.push(resolve)
    })
  }
  decoder.decode(atlas.chunks[0])
  const firstFrame = await nextFrame()
  const canvas = new OffscreenCanvas(atlas.width, atlas.height)
  const ctx = canvas.getContext("2d")
  if (ctx === null) {
    throw new Error("prewarmAtlas: no 2d context")
  }
  ctx.drawImage(firstFrame, 0, 0)
  firstFrame.close()
  const bitmap = canvas.transferToImageBitmap()
  return { bitmap, decoder, nextFrame }
}

interface CellSource {
  kind: "live" | "bitmap" | "atlas"
  bitmaps?: ImageBitmap[]
  /** For atlas: which row in the current atlas this cell maps to. */
  atlasRow?: number
}

interface AtlasState {
  bitmap: ImageBitmap
  decoder: VideoDecoder
  rows: number
  framePending: VideoFrame | null
  chunks: EncodedVideoChunk[]
  /** Highest cell index (= rows - 1) that this atlas covers. */
  coversUpToIndex: number
}

interface StageStats {
  stage: number
  cellCount: number
  bitmapKeepUpRatio: number
  rebuildMs: number
  rebuildRateVsRealtime: number
  /** Wall-clock from stop[N] to start[N+1]. Production-shape gap. */
  gapBeforeThisTakeMs: number
  /** Wall-clock from stop[N] to atlas[N] in cells. Background latency. */
  atlasReadyDelayMs: number
  recordRenderFps: number
  recordRenderP95Ms: number
  recordRenderMaxMs: number
  recordFramesOver33ms: number
  integrity: IntegrityReport
}

async function run(): Promise<void> {
  status(`progressive-overlap session: ${params.stages} stages × ${params.takeSeconds}s takes`)

  status(`acquiring camera...`)
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: params.captureResolution.width, height: params.captureResolution.height },
    audio: true,
  })
  const liveVideo = document.createElement("video")
  liveVideo.muted = true
  liveVideo.playsInline = true
  liveVideo.autoplay = true
  liveVideo.srcObject = new MediaStream(stream.getVideoTracks())
  await new Promise<void>(resolve => {
    liveVideo.onloadedmetadata = () => resolve()
  })
  await liveVideo.play()

  const canvas = document.createElement("canvas")
  canvas.width = params.canvasResolution.width
  canvas.height = params.canvasResolution.height
  canvas.style.cssText = "display:block;width:200px;height:auto;border:1px solid #444"
  document.body.appendChild(canvas)
  const glOrNull = canvas.getContext("webgl2")
  if (glOrNull === null) {
    throw new Error("no webgl2")
  }
  const gl: WebGL2RenderingContext = glOrNull
  const vs = gl.createShader(gl.VERTEX_SHADER)!
  gl.shaderSource(
    vs,
    `#version 300 es
in vec2 aQuad;
uniform vec2 uNdcOffset;
uniform vec2 uNdcScale;
uniform vec2 uUvOffset;
uniform vec2 uUvScale;
out vec2 vUv;
void main() {
  vec2 corner = (aQuad + 1.0) * 0.5;
  vUv = uUvOffset + corner * uUvScale;
  gl_Position = vec4(uNdcOffset + corner * uNdcScale, 0.0, 1.0);
}`,
  )
  gl.compileShader(vs)
  const fs = gl.createShader(gl.FRAGMENT_SHADER)!
  gl.shaderSource(
    fs,
    `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uTex;
out vec4 outColor;
void main() { outColor = texture(uTex, vUv); }`,
  )
  gl.compileShader(fs)
  const program = gl.createProgram()!
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  gl.useProgram(program)
  const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1])
  const vbo = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW)
  const aQuad = gl.getAttribLocation(program, "aQuad")
  gl.enableVertexAttribArray(aQuad)
  gl.vertexAttribPointer(aQuad, 2, gl.FLOAT, false, 0, 0)
  const uNdcOffset = gl.getUniformLocation(program, "uNdcOffset")
  const uNdcScale = gl.getUniformLocation(program, "uNdcScale")
  const uUvOffset = gl.getUniformLocation(program, "uUvOffset")
  const uUvScale = gl.getUniformLocation(program, "uUvScale")
  const atlasTex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, atlasTex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  const liveTex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, liveTex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  const bitmapTex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, bitmapTex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

  const cells: CellSource[] = []
  let liveActive: HTMLVideoElement | null = null
  let atlasState: AtlasState | null = null
  let stop = false
  let lastFrameTimeMs = performance.now()
  /** All recorded frame-times during the run, with stage boundaries. */
  const frameTimes: number[] = []
  const stageStart: number[] = [] // index = stage, value = frameTimes.length at stage start
  let currentStageIndex = 0
  const startWall = performance.now()

  function tick() {
    if (stop) {
      return
    }
    const now = performance.now()
    const frameTime = now - lastFrameTimeMs
    lastFrameTimeMs = now
    frameTimes.push(frameTime)

    const elapsed = now - startWall
    // Paint atlas if pending
    if (atlasState !== null && atlasState.framePending !== null) {
      gl.bindTexture(gl.TEXTURE_2D, atlasTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlasState.framePending)
    } else if (atlasState !== null) {
      gl.bindTexture(gl.TEXTURE_2D, atlasTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlasState.bitmap)
    }
    // Paint live
    if (liveActive !== null && liveActive.readyState >= 2) {
      gl.bindTexture(gl.TEXTURE_2D, liveTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, liveActive)
    }
    const N = cells.length
    if (N > 0) {
      const sliceH = 2 / N
      for (let i = 0; i < N; i++) {
        const cell = cells[i]
        const ndcY = 1 - (i + 1) * sliceH
        // Prefer atlas if this cell is covered by the current atlas
        if (atlasState !== null && i <= atlasState.coversUpToIndex) {
          gl.bindTexture(gl.TEXTURE_2D, atlasTex)
          gl.uniform2f(uUvOffset, 0, i / atlasState.rows)
          gl.uniform2f(uUvScale, 1, 1 / atlasState.rows)
        } else if (cell.kind === "live" && liveActive !== null) {
          gl.bindTexture(gl.TEXTURE_2D, liveTex)
          gl.uniform2f(uUvOffset, 0, 0)
          gl.uniform2f(uUvScale, 1, 1)
        } else if (cell.kind === "bitmap" && cell.bitmaps && cell.bitmaps.length > 0) {
          const frameIdx = Math.floor((elapsed / 1000) * params.assumedFps) % cell.bitmaps.length
          gl.bindTexture(gl.TEXTURE_2D, bitmapTex)
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            cell.bitmaps[frameIdx],
          )
          gl.uniform2f(uUvOffset, 0, 0)
          gl.uniform2f(uUvScale, 1, 1)
        } else {
          continue
        }
        gl.uniform2f(uNdcOffset, -1, ndcY)
        gl.uniform2f(uNdcScale, 2, sliceH)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      }
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  const clips: ProbeInput[] = []
  const stats: StageStats[] = []
  /** Per-stage: when rebuild's atlas with N cells became visible. */
  const atlasArrivedMs: Record<number, number> = {}
  const stageStopMs: Record<number, number> = {}
  /** When the previous stage's recording stopped — used to measure
   *  the user-visible gap before the current stage's recording starts. */
  let lastStopMs: number | null = null

  // Background rebuild queue: latest-wins. inFlight is the worker
  // currently running; pendingClips is the next clip set to queue
  // when inFlight finishes (latest only).
  let inFlightBuild: { done: Promise<AtlasBuildResponse>; terminate(): void; forStage: number } | null =
    null
  let pendingClips: { clips: ProbeInput[]; forStage: number } | null = null
  let buildLoopActive = false

  async function applyBuiltAtlas(atlas: ProbeInput, forStage: number) {
    const prewarm = await prewarmAtlas(atlas)
    if (atlasState !== null) {
      atlasState.decoder.close()
      atlasState.bitmap.close()
      if (atlasState.framePending !== null) {
        atlasState.framePending.close()
      }
    }
    atlasState = {
      bitmap: prewarm.bitmap,
      decoder: prewarm.decoder,
      rows: forStage,
      framePending: null,
      chunks: atlas.chunks,
      coversUpToIndex: forStage - 1,
    }
    atlasArrivedMs[forStage] = performance.now()
    // Free bitmaps for now-covered cells
    for (let i = 0; i < forStage; i++) {
      const cell = cells[i]
      if (cell.kind === "bitmap" && cell.bitmaps) {
        for (const bitmap of cell.bitmaps) {
          bitmap.close()
        }
        cells[i] = { kind: "atlas", atlasRow: i }
      }
    }
    // Start feeding subsequent chunks at 30fps from a side loop
    ;(async () => {
      const ref = atlasState
      if (ref === null) {
        return
      }
      for (let i = 1; i < atlas.chunks.length; i++) {
        if (stop || ref !== atlasState) {
          break
        }
        try {
          ref.decoder.decode(atlas.chunks[i])
          const frame = await prewarm.nextFrame()
          if (ref.framePending !== null) {
            ref.framePending.close()
          }
          ref.framePending = frame
        } catch {
          break
        }
        await wait(33)
      }
    })()
  }

  async function processBuildQueue() {
    if (buildLoopActive) {
      return
    }
    buildLoopActive = true
    while (pendingClips !== null || inFlightBuild !== null) {
      if (inFlightBuild === null && pendingClips !== null) {
        const next = pendingClips
        pendingClips = null
        const handle = rebuildAtlasInWorker(next.clips)
        inFlightBuild = { ...handle, forStage: next.forStage }
      }
      if (inFlightBuild !== null) {
        const myBuild = inFlightBuild
        try {
          const response = await myBuild.done
          myBuild.terminate()
          // If a newer pending exists, this output is stale — discard
          // and proceed to next.
          if (pendingClips === null || pendingClips.forStage === myBuild.forStage) {
            await applyBuiltAtlas(response.atlas, myBuild.forStage)
            for (const stat of stats) {
              if (stat.stage === myBuild.forStage && stat.atlasReadyDelayMs === 0) {
                stat.atlasReadyDelayMs = atlasArrivedMs[myBuild.forStage] - stageStopMs[myBuild.forStage]
                stat.rebuildMs = response.compositeMs
                stat.rebuildRateVsRealtime =
                  response.compositeMs / 1000 / params.takeSeconds
              }
            }
          }
        } catch {
          // build failed; skip
        }
        inFlightBuild = null
      }
    }
    buildLoopActive = false
  }

  for (let stage = 1; stage <= params.stages; stage++) {
    currentStageIndex = stage
    stageStart[stage] = frameTimes.length
    status(`STAGE ${stage}/${params.stages}: ${stage} cells, recording into cell ${stage - 1}...`)

    cells.push({ kind: "live" })
    liveActive = liveVideo
    const recordStartFrameIdx = frameTimes.length
    const recordStartMs = performance.now()
    const gapBeforeThisTakeMs = lastStopMs === null ? 0 : recordStartMs - lastStopMs
    const result = await recordWithBitmaps(stream, params.takeSeconds)
    const recordEndMs = performance.now()
    const recordFrames = frameTimes.slice(recordStartFrameIdx)
    const recordSortedTimes = recordFrames.slice().sort((a, b) => a - b)
    const p95Idx = Math.min(recordSortedTimes.length - 1, Math.floor(recordSortedTimes.length * 0.95))
    const recordP95 = recordSortedTimes[p95Idx] ?? 0
    const recordMax = recordSortedTimes[recordSortedTimes.length - 1] ?? 0
    const framesOver33 = recordFrames.filter(t => t > 33).length
    const recordRenderFps = recordFrames.length / ((recordEndMs - recordStartMs) / 1000)

    cells[stage - 1] = { kind: "bitmap", bitmaps: result.bitmaps }
    liveActive = null
    clips.push(result.clip)
    stageStopMs[stage] = recordEndMs
    lastStopMs = recordEndMs

    const integrity = checkIntegrity(result.frameTimestamps, params.takeSeconds)

    // Queue rebuild for ALL clips so far. latest-wins.
    pendingClips = { clips: clips.slice(), forStage: stage }
    processBuildQueue()  // fire-and-forget

    const placeholder: StageStats = {
      stage,
      cellCount: stage,
      bitmapKeepUpRatio: result.bitmapKeepUpRatio,
      rebuildMs: 0,
      rebuildRateVsRealtime: 0,
      gapBeforeThisTakeMs: gapBeforeThisTakeMs,
      atlasReadyDelayMs: 0,
      recordRenderFps,
      recordRenderP95Ms: recordP95,
      recordRenderMaxMs: recordMax,
      recordFramesOver33ms: framesOver33,
      integrity,
    }
    stats.push(placeholder)
    status(
      `  recorded ${integrity.framesActual}f (expected ${integrity.framesExpected}, dropped ${integrity.framesDropped}, fps ${integrity.measuredFps.toFixed(1)}); ` +
        `render p95=${recordP95.toFixed(1)}ms max=${recordMax.toFixed(1)}ms over33=${framesOver33}; ` +
        `gapBeforeThisTake=${gapBeforeThisTakeMs.toFixed(1)}ms`,
    )
  }

  // Wait for build queue to drain so all atlas-ready delays are filled.
  status(`session takes complete; draining build queue...`)
  while (pendingClips !== null || inFlightBuild !== null) {
    await wait(50)
  }

  stop = true
  for (const track of stream.getTracks()) {
    track.stop()
  }
  liveVideo.srcObject = null
  document.body.removeChild(canvas)

  const sessionSeconds = (performance.now() - startWall) / 1000
  status(`SESSION COMPLETE: ${sessionSeconds.toFixed(1)}s`)
  status("done.")
  reportResult("progressive-overlap", params, {
    stages: stats,
    sessionSeconds,
  })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("progressive-overlap", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
