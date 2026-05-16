// progressive-record — 9-stage integration test of the full eddy
// flow. Stage N: viewport divided into N horizontal slices, last
// slice = live camera + recording, others = playback from sub-atlas.
// After each take, sub-atlas rebuilds in worker; cells swap to new
// atlas; advance to stage N+1.

import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from "mediabunny"
import { wait } from "../../src/utils"
import type { ProbeInput } from "../harness/input"
import { reportResult, status } from "../harness/report"

const params = {
  captureResolution: { width: 1280, height: 720 },
  // Canvas matches CSS-px viewport per 10's verdict.
  canvasResolution: { width: 540, height: 982 },
  // 6s takes (not 10s) so the 9-stage session fits the 180s harness
  // timeout: ~9×6 record + ~9×7 rebuild ≈ 120s.
  takeSeconds: 6,
  stages: 9,
  // Bitmap series cell size — small enough to be cheap, big enough
  // for the renderer to do something visible. Per cell (which changes
  // size each stage), bitmaps are generated at the LARGEST cell size
  // we'll need (stage 1 = full canvas). They'll be downscaled at
  // draw time as needed.
  bitmapResolution: { width: 270, height: 491 },
  maxQueue: 8,
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

/** Record `seconds` from the (already-acquired) MediaStream, demux to
 *  ProbeInput, AND emit bitmaps to a worker in parallel. Returns at
 *  stop: the demuxed clip + the assembled bitmap array. */
async function recordWithBitmaps(
  stream: MediaStream,
  seconds: number,
): Promise<{ clip: ProbeInput; bitmaps: ImageBitmap[]; bitmapKeepUpRatio: number }> {
  const processorCtor = (globalThis as unknown as {
    MediaStreamTrackProcessor?: new (init: { track: MediaStreamTrack }) => {
      readable: ReadableStream<VideoFrame>
    }
  }).MediaStreamTrackProcessor
  if (processorCtor === undefined) {
    throw new Error("recordWithBitmaps: MediaStreamTrackProcessor unavailable")
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
  for await (const packet of sink.packets()) {
    const chunk = packet.toEncodedVideoChunk()
    if (chunks.length === 0 && chunk.type !== "key") {
      continue
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) {
    throw new Error("recordWithBitmaps: no keyframe in recording")
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
    bitmapKeepUpRatio: chunks.length === 0 ? 0 : doneMessage.bitmapsEmitted / chunks.length,
  }
}

function rebuildAtlasInWorker(clips: ProbeInput[]): {
  done: Promise<AtlasBuildResponse>
  terminate(): void
} {
  // Atlas: 1 column × N rows (vertical stack matches viewport split).
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

/** Decode `atlas` chunk 0, draw the first frame into a small canvas,
 *  transferToImageBitmap. Returns the held bitmap + open decoder
 *  (state retained for chunk 1+). Per 16. */
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
  /** For bitmap source: the bitmap series for this cell. */
  bitmaps?: ImageBitmap[]
  /** For atlas source: row index within the (cols=1, rows=N) atlas. */
  atlasRow?: number
}

interface RenderState {
  /** The shared atlas state — null until first atlas is built. */
  atlas: {
    bitmap: ImageBitmap // pre-warmed first frame (16 pattern)
    nextFrame(): Promise<VideoFrame>
    decoder: VideoDecoder
    rows: number
    width: number
    height: number
    framePending: VideoFrame | null
  } | null
  /** The cells, in order top-to-bottom. cells.length = stage number. */
  cells: CellSource[]
  /** Bound to the live camera; null when no live cell. */
  liveVideo: HTMLVideoElement | null
}

interface StageStats {
  stage: number
  cellCount: number
  bitmapKeepUpRatio: number
  rebuildMs: number
  rebuildRateVsRealtime: number
  /** rendered fps during the recording window. */
  recordRenderFps: number
  /** rendered fps during the rebuild window (after stop, before atlas). */
  rebuildRenderFps: number
  stageWallClockSeconds: number
}

async function run(): Promise<void> {
  status(`progressive-record session: ${params.stages} stages × ${params.takeSeconds}s takes`)

  // Single getUserMedia for the whole session.
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

  // Canvas + WebGL2.
  const canvas = document.createElement("canvas")
  canvas.width = params.canvasResolution.width
  canvas.height = params.canvasResolution.height
  canvas.style.cssText = "display:block;width:200px;height:auto;border:1px solid #444"
  document.body.appendChild(canvas)
  const glOrNull = canvas.getContext("webgl2")
  if (glOrNull === null) {
    throw new Error("no webgl2 context")
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

  const state: RenderState = { atlas: null, cells: [], liveVideo: null }
  let stop = false
  let frameCount = 0
  const startWall = performance.now()

  // Atlas decoder feeds out-of-band (per-stage async loop, below).
  // tick() just paints whatever's latest.
  let atlasCursor = 0
  let atlasStartMs = 0

  function tick() {
    if (stop) {
      return
    }
    const elapsed = performance.now() - startWall
    // Upload latest atlas frame if available
    if (state.atlas !== null && state.atlas.framePending !== null) {
      gl.bindTexture(gl.TEXTURE_2D, atlasTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, state.atlas.framePending)
    } else if (state.atlas !== null) {
      // No new frame yet — paint from pre-warmed bitmap once.
      gl.bindTexture(gl.TEXTURE_2D, atlasTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, state.atlas.bitmap)
    }
    // Upload live video
    if (state.liveVideo !== null && state.liveVideo.readyState >= 2) {
      gl.bindTexture(gl.TEXTURE_2D, liveTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, state.liveVideo)
    }
    // Draw each cell at its slice.
    const N = state.cells.length
    if (N > 0) {
      const sliceH = 2 / N
      for (let i = 0; i < N; i++) {
        const cell = state.cells[i]
        // ndc bottom-left: y = 1 - (i+1) * sliceH
        const ndcY = 1 - (i + 1) * sliceH
        if (cell.kind === "atlas" && state.atlas !== null) {
          gl.bindTexture(gl.TEXTURE_2D, atlasTex)
          gl.uniform2f(uUvOffset, 0, (cell.atlasRow ?? 0) / state.atlas.rows)
          gl.uniform2f(uUvScale, 1, 1 / state.atlas.rows)
        } else if (cell.kind === "live" && state.liveVideo !== null) {
          gl.bindTexture(gl.TEXTURE_2D, liveTex)
          gl.uniform2f(uUvOffset, 0, 0)
          gl.uniform2f(uUvScale, 1, 1)
        } else if (cell.kind === "bitmap" && cell.bitmaps && cell.bitmaps.length > 0) {
          // Paint the bitmap at index based on elapsed time (looping).
          const frameIdx = Math.floor((elapsed / 1000) * 30) % cell.bitmaps.length
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
          // Empty / black — skip draw (canvas starts black).
          continue
        }
        gl.uniform2f(uNdcOffset, -1, ndcY)
        gl.uniform2f(uNdcScale, 2, sliceH)
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      }
    }
    frameCount++
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)

  const clips: ProbeInput[] = []
  const cellBitmaps: ImageBitmap[][] = [] // bitmaps per cell, kept until that cell flips to atlas
  const stats: StageStats[] = []

  for (let stage = 1; stage <= params.stages; stage++) {
    const stageStart = performance.now()
    status(`STAGE ${stage}/${params.stages}: ${stage} cells, recording into cell ${stage - 1}...`)

    // Add new live cell to layout.
    state.cells.push({ kind: "live" })
    state.liveVideo = liveVideo
    const renderFramesBefore = frameCount
    const recordStart = performance.now()

    const { clip, bitmaps, bitmapKeepUpRatio } = await recordWithBitmaps(stream, params.takeSeconds)
    const recordEnd = performance.now()
    const renderFramesDuringRecord = frameCount - renderFramesBefore
    const recordRenderFps = renderFramesDuringRecord / ((recordEnd - recordStart) / 1000)
    status(
      `  recorded ${clip.chunks.length} chunks, ${bitmaps.length} bitmaps (keep-up ${(bitmapKeepUpRatio * 100).toFixed(0)}%), renderFps ${recordRenderFps.toFixed(1)}`,
    )

    // Switch new cell to bitmap source; release live.
    cellBitmaps.push(bitmaps)
    state.cells[stage - 1] = { kind: "bitmap", bitmaps }
    state.liveVideo = null
    clips.push(clip)

    // Rebuild atlas with all N clips.
    const renderFramesBeforeRebuild = frameCount
    const rebuildStart = performance.now()
    const build = rebuildAtlasInWorker(clips)
    const buildResponse = await build.done
    build.terminate()
    const rebuildEnd = performance.now()
    const renderFramesDuringRebuild = frameCount - renderFramesBeforeRebuild
    const rebuildRenderFps = renderFramesDuringRebuild / ((rebuildEnd - rebuildStart) / 1000)
    status(
      `  atlas built ${buildResponse.compositeMs.toFixed(0)}ms (${(buildResponse.compositeMs / 1000 / params.takeSeconds).toFixed(2)}× realtime), renderFps ${rebuildRenderFps.toFixed(1)}`,
    )

    // Pre-warm + swap atlas — old atlas (if any) replaced by new.
    if (state.atlas !== null) {
      state.atlas.decoder.close()
      state.atlas.bitmap.close()
      if (state.atlas.framePending) {
        state.atlas.framePending.close()
      }
    }
    const prewarm = await prewarmAtlas(buildResponse.atlas)
    atlasStartMs = performance.now() - startWall
    atlasCursor = 1 // chunk 0 already decoded
    state.atlas = {
      bitmap: prewarm.bitmap,
      nextFrame: prewarm.nextFrame,
      decoder: prewarm.decoder,
      rows: clips.length,
      width: buildResponse.atlas.width,
      height: buildResponse.atlas.height,
      framePending: null,
    }
    // Drive subsequent frames out of band: feed chunks at 30fps from
    // here on; output handler updates framePending.
    ;(async () => {
      const atlasRef = state.atlas
      if (atlasRef === null) {
        return
      }
      while (!stop && atlasCursor < buildResponse.atlas.chunks.length) {
        try {
          atlasRef.decoder.decode(buildResponse.atlas.chunks[atlasCursor])
          const frame = await prewarm.nextFrame()
          if (atlasRef.framePending !== null) {
            atlasRef.framePending.close()
          }
          atlasRef.framePending = frame
          atlasCursor++
          await wait(33)
        } catch {
          break
        }
      }
    })()

    // Flip all existing cells (those that were bitmap) to atlas.
    for (let i = 0; i < clips.length; i++) {
      const old = state.cells[i]
      if (old.kind === "bitmap" && old.bitmaps) {
        for (const bitmap of old.bitmaps) {
          bitmap.close()
        }
      }
      state.cells[i] = { kind: "atlas", atlasRow: i }
    }

    const stageEnd = performance.now()
    stats.push({
      stage,
      cellCount: stage,
      bitmapKeepUpRatio,
      rebuildMs: buildResponse.compositeMs,
      rebuildRateVsRealtime: buildResponse.compositeMs / 1000 / params.takeSeconds,
      recordRenderFps,
      rebuildRenderFps,
      stageWallClockSeconds: (stageEnd - stageStart) / 1000,
    })
  }

  stop = true
  for (const track of stream.getTracks()) {
    track.stop()
  }
  liveVideo.srcObject = null
  document.body.removeChild(canvas)

  const sessionSeconds = (performance.now() - startWall) / 1000
  const minRecordFps = Math.min(...stats.map(s => s.recordRenderFps))
  const minRebuildFps = Math.min(...stats.map(s => s.rebuildRenderFps))
  status(
    `SESSION COMPLETE: ${sessionSeconds.toFixed(1)}s, minRecordFps=${minRecordFps.toFixed(1)}, minRebuildFps=${minRebuildFps.toFixed(1)}`,
  )
  status("done.")
  reportResult("progressive-record", params, {
    stages: stats,
    sessionSeconds,
    minRecordFps,
    minRebuildFps,
  })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("progressive-record", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
