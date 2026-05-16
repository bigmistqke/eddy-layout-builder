// progressive-streams — simplest possible: K decoders, no atlas, no
// bitmaps, no worker rebuild. Tests whether pure streaming holds
// realtime through 9 progressive recordings on the A15.

import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from "mediabunny"
import { wait } from "../../src/utils"
import type { ProbeInput } from "../harness/input"
import { reportResult, status } from "../harness/report"

const params = {
  captureResolution: { width: 1280, height: 720 },
  canvasResolution: { width: 540, height: 982 },
  takeSeconds: 6,
  stages: 9,
  maxQueue: 8,
  /** Decoder feed target: one chunk per (1000/30)ms tick. */
  targetFps: 30,
}

interface PacedDecoder {
  latestFrame(): VideoFrame | null
  feedTo(elapsedMs: number): void
  stop(): void
  /** When this cell's decoder was started (rAF clock). */
  startMs: number
}

function makePacedDecoder(clip: ProbeInput, startMs: number): PacedDecoder {
  let latest: VideoFrame | null = null
  let cursor = 0
  let loopStartMs = startMs
  let wrapping = false
  const decoder = new VideoDecoder({
    output(frame) {
      if (latest !== null) {
        latest.close()
      }
      latest = frame
    },
    error() {},
  })
  decoder.configure(clip.config)
  const clipDurationMs = (clip.chunks.length / params.targetFps) * 1000

  return {
    latestFrame: () => latest,
    feedTo(elapsedMs) {
      if (wrapping) {
        return
      }
      const elapsedInLoop = elapsedMs - (loopStartMs - startMs)
      const targetCursor = Math.min(
        clip.chunks.length,
        Math.floor((elapsedInLoop * params.targetFps) / 1000) + 1,
      )
      while (cursor < targetCursor && decoder.decodeQueueSize < params.maxQueue) {
        decoder.decode(clip.chunks[cursor])
        cursor++
      }
      // When playhead passes the end of the clip, reset decoder for
      // the next loop. Async — feedTo returns immediately, wrapping
      // flag suppresses further feeds until reset completes.
      if (cursor >= clip.chunks.length && elapsedInLoop >= clipDurationMs) {
        wrapping = true
        decoder
          .flush()
          .then(() => {
            decoder.reset()
            decoder.configure(clip.config)
            cursor = 0
            loopStartMs += clipDurationMs
            wrapping = false
          })
          .catch(() => {
            wrapping = false
          })
      }
    },
    stop: () => {
      if (latest !== null) {
        latest.close()
        latest = null
      }
      decoder.close()
    },
    startMs,
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
  const meanInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length
  const maxInterval = Math.max(...intervals)
  const measuredFps = 1000 / meanInterval
  const dropThreshold = meanInterval * 1.5
  let drops = 0
  for (const i of intervals) {
    if (i > dropThreshold) {
      drops += Math.round(i / meanInterval) - 1
    }
  }
  return {
    framesActual: timestamps.length,
    framesExpected: Math.round(measuredFps * expectedSeconds),
    framesDropped: drops,
    meanIntervalMs: meanInterval,
    maxIntervalMs: maxInterval,
    measuredFps,
  }
}

async function recordClip(stream: MediaStream, seconds: number): Promise<{
  clip: ProbeInput
  frameTimestamps: number[]
}> {
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
  const blob = new Blob(blobParts, { type: mimeType })
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  const recordedTrack = await input.getPrimaryVideoTrack()
  if (recordedTrack === null) {
    throw new Error("recordClip: no video track")
  }
  const config = await recordedTrack.getDecoderConfig()
  if (config === null) {
    throw new Error("recordClip: no decoder config")
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
    throw new Error("recordClip: no keyframe")
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
    frameTimestamps,
  }
}

interface StageStats {
  stage: number
  cellCount: number
  gapBeforeThisTakeMs: number
  recordRenderFps: number
  recordRenderP95Ms: number
  recordRenderMaxMs: number
  recordFramesOver33ms: number
  integrity: IntegrityReport
}

interface CellSource {
  kind: "live" | "stream"
  decoder?: PacedDecoder
}

function readHeapMb(): number {
  const perf = performance as unknown as { memory?: { usedJSHeapSize: number } }
  return perf.memory ? perf.memory.usedJSHeapSize / 1_000_000 : 0
}

async function run(): Promise<void> {
  status(`progressive-streams session: ${params.stages} stages × ${params.takeSeconds}s takes`)
  status(`initial heap: ${readHeapMb().toFixed(1)} MB`)

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
out vec2 vUv;
void main() {
  vec2 corner = (aQuad + 1.0) * 0.5;
  vUv = corner;
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
  function makeTex(): WebGLTexture {
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return tex
  }
  const liveTex = makeTex()
  const streamTex = makeTex()

  const cells: CellSource[] = []
  let liveActive: HTMLVideoElement | null = null
  let stop = false
  let lastFrameTimeMs = performance.now()
  const frameTimes: number[] = []
  let peakHeapMb = readHeapMb()
  const startWall = performance.now()

  function tick() {
    if (stop) {
      return
    }
    const now = performance.now()
    const frameTime = now - lastFrameTimeMs
    lastFrameTimeMs = now
    frameTimes.push(frameTime)

    if (frameTimes.length % 30 === 0) {
      const h = readHeapMb()
      if (h > peakHeapMb) {
        peakHeapMb = h
      }
    }

    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)

    // Feed each stream decoder up to its target frame for now.
    for (const cell of cells) {
      if (cell.kind === "stream" && cell.decoder) {
        cell.decoder.feedTo(now - cell.decoder.startMs)
      }
    }

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
        if (cell.kind === "live" && liveActive !== null) {
          gl.bindTexture(gl.TEXTURE_2D, liveTex)
        } else if (cell.kind === "stream" && cell.decoder) {
          const frame = cell.decoder.latestFrame()
          if (frame === null) {
            continue
          }
          gl.bindTexture(gl.TEXTURE_2D, streamTex)
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame)
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

  const stats: StageStats[] = []
  let lastStopMs: number | null = null

  for (let stage = 1; stage <= params.stages; stage++) {
    status(`STAGE ${stage}/${params.stages}: ${stage} cells, recording into cell ${stage - 1}...`)
    cells.push({ kind: "live" })
    liveActive = liveVideo
    const recordStartFrameIdx = frameTimes.length
    const recordStartMs = performance.now()
    const gapBeforeThisTakeMs = lastStopMs === null ? 0 : recordStartMs - lastStopMs
    const result = await recordClip(stream, params.takeSeconds)
    const recordEndMs = performance.now()
    const recordFrames = frameTimes.slice(recordStartFrameIdx)
    const sorted = recordFrames.slice().sort((a, b) => a - b)
    const p95Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))
    const recordP95 = sorted[p95Idx] ?? 0
    const recordMax = sorted[sorted.length - 1] ?? 0
    const framesOver33 = recordFrames.filter(t => t > 33).length
    const recordRenderFps = recordFrames.length / ((recordEndMs - recordStartMs) / 1000)

    // Flip cell to stream source: spin up its decoder, advance.
    const decoder = makePacedDecoder(result.clip, performance.now())
    cells[stage - 1] = { kind: "stream", decoder }
    liveActive = null
    lastStopMs = recordEndMs

    const integrity = checkIntegrity(result.frameTimestamps, params.takeSeconds)
    const heap = readHeapMb()
    if (heap > peakHeapMb) {
      peakHeapMb = heap
    }
    stats.push({
      stage,
      cellCount: stage,
      gapBeforeThisTakeMs,
      recordRenderFps,
      recordRenderP95Ms: recordP95,
      recordRenderMaxMs: recordMax,
      recordFramesOver33ms: framesOver33,
      integrity,
    })
    status(
      `  recorded ${integrity.framesActual}f (dropped ${integrity.framesDropped}, fps ${integrity.measuredFps.toFixed(1)}); ` +
        `render fps=${recordRenderFps.toFixed(1)} p95=${recordP95.toFixed(1)}ms max=${recordMax.toFixed(1)}ms over33=${framesOver33}; ` +
        `gap=${gapBeforeThisTakeMs.toFixed(1)}ms; heap=${heap.toFixed(1)}MB`,
    )
  }

  stop = true
  for (const cell of cells) {
    if (cell.kind === "stream" && cell.decoder) {
      cell.decoder.stop()
    }
  }
  for (const track of stream.getTracks()) {
    track.stop()
  }
  liveVideo.srcObject = null
  document.body.removeChild(canvas)

  const sessionSeconds = (performance.now() - startWall) / 1000
  status(
    `SESSION COMPLETE: ${sessionSeconds.toFixed(1)}s, peakHeap=${peakHeapMb.toFixed(1)}MB`,
  )
  status("done.")
  reportResult("progressive-streams", params, {
    stages: stats,
    sessionSeconds,
    peakHeapMb,
  })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("progressive-streams", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
