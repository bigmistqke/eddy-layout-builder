// upload-real-sources — measure texImage2D upload cost for three
// real-world sources: Uint8Array (OPFS-bitmap proxy), decoded
// VideoFrame from VideoDecoder, and camera VideoFrame via
// MediaStreamTrackProcessor. Sweeps resolution × K for the first
// two; camera at native res only.

import { wait } from "../../src/utils"
import { recordProbeInput, type ProbeInput } from "../harness/input"
import { reportResult, status } from "../harness/report"

const params = {
  captureResolution: { width: 1280, height: 720 },
  sourceSeconds: 6,
  cellDurationMs: 2000,
  bitratePerPixel: 0.1,
  swCodec: { label: "av1", codecString: "av01.0.04M.08" },
  resolutions: [
    { label: "540p", width: 960, height: 544 },
    { label: "360p", width: 640, height: 368 },
    { label: "270p", width: 480, height: 272 },
    { label: "180p", width: 320, height: 184 },
    { label: "144p", width: 256, height: 144 },
  ],
  kValues: [1, 4, 8, 16],
}

const snap16 = (value: number): number => Math.max(16, Math.round(value / 16) * 16)

interface MipAsset {
  label: string
  width: number
  height: number
  config: VideoDecoderConfig
  chunks: EncodedVideoChunk[]
}

async function transcodeMip(
  source: ProbeInput,
  label: string,
  targetW: number,
  targetH: number,
): Promise<MipAsset | null> {
  const width = snap16(targetW)
  const height = snap16(targetH)
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext("2d")
  if (context === null) {
    return null
  }
  const chunks: EncodedVideoChunk[] = []
  let decoderConfig: VideoDecoderConfig | null = null
  const bitrate = Math.round(width * height * 30 * params.bitratePerPixel)
  const encoder = new VideoEncoder({
    output(chunk, metadata) {
      chunks.push(chunk)
      if (decoderConfig === null && metadata?.decoderConfig) {
        decoderConfig = metadata.decoderConfig
      }
    },
    error() {},
  })
  try {
    encoder.configure({
      codec: params.swCodec.codecString,
      width,
      height,
      bitrate,
      framerate: 30,
    })
  } catch {
    encoder.close()
    return null
  }
  let frameIdx = 0
  const sourceDecoder = new VideoDecoder({
    output(frame) {
      try {
        context.drawImage(frame, 0, 0, width, height)
        const scaled = new VideoFrame(canvas, { timestamp: frame.timestamp })
        encoder.encode(scaled, { keyFrame: frameIdx === 0 })
        scaled.close()
      } catch {}
      frame.close()
      frameIdx++
    },
    error() {},
  })
  sourceDecoder.configure(source.config)
  for (const chunk of source.chunks) {
    sourceDecoder.decode(chunk)
  }
  await sourceDecoder.flush()
  sourceDecoder.close()
  try {
    await encoder.flush()
  } catch {}
  encoder.close()
  if (chunks.length === 0 || decoderConfig === null) {
    return null
  }
  return { label, width, height, config: decoderConfig, chunks }
}

interface DecoderSlot {
  decoder: VideoDecoder
  latest: VideoFrame | null
  framesProduced: number
  stop(): void
}

function makeDecoderSlot(asset: MipAsset): DecoderSlot {
  const slot: DecoderSlot = {
    decoder: null as unknown as VideoDecoder,
    latest: null,
    framesProduced: 0,
    stop() {
      if (this.latest !== null) {
        try {
          this.latest.close()
        } catch {}
        this.latest = null
      }
      try {
        this.decoder.close()
      } catch {}
    },
  }
  slot.decoder = new VideoDecoder({
    output(frame) {
      slot.framesProduced++
      if (slot.latest !== null) {
        try {
          slot.latest.close()
        } catch {}
      }
      slot.latest = frame
    },
    error() {},
  })
  try {
    slot.decoder.configure({ ...asset.config, hardwareAcceleration: "prefer-software" })
  } catch {}
  return slot
}

/** Feed a decoder slot continuously while measurement is running. */
function startSlotPump(slot: DecoderSlot, asset: MipAsset, stopRef: { stop: boolean }): Promise<void> {
  return (async () => {
    let cursor = 0
    while (!stopRef.stop) {
      while (slot.decoder.decodeQueueSize < 4 && !stopRef.stop) {
        try {
          slot.decoder.decode(asset.chunks[cursor % asset.chunks.length])
        } catch {
          stopRef.stop = true
          break
        }
        cursor++
      }
      await wait(2)
    }
  })()
}

interface CameraSource {
  ring: VideoFrame[]
  stop(): void
  framesObserved: number
}

async function startCameraSource(k: number): Promise<{ source: CameraSource; width: number; height: number }> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: params.captureResolution.width, height: params.captureResolution.height },
    audio: false,
  })
  const [track] = stream.getVideoTracks()
  const settings = track.getSettings()
  const width = settings.width ?? params.captureResolution.width
  const height = settings.height ?? params.captureResolution.height
  // Type assertion — MediaStreamTrackProcessor isn't in all TS lib defs.
  const Ctor = (window as unknown as { MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> } }).MediaStreamTrackProcessor
  const processor = new Ctor({ track })
  const reader = processor.readable.getReader()
  const ring: VideoFrame[] = []
  let stopped = false
  let framesObserved = 0
  ;(async () => {
    while (!stopped) {
      const { value, done } = await reader.read()
      if (done) {
        break
      }
      framesObserved++
      ring.push(value)
      while (ring.length > k) {
        const old = ring.shift()
        if (old !== undefined) {
          try {
            old.close()
          } catch {}
        }
      }
    }
    try {
      reader.releaseLock()
    } catch {}
  })()
  return {
    source: {
      ring,
      get framesObserved() {
        return framesObserved
      },
      stop() {
        stopped = true
        for (const frame of ring) {
          try {
            frame.close()
          } catch {}
        }
        ring.length = 0
        track.stop()
      },
    } as CameraSource,
    width,
    height,
  }
}

type SourceType = "uint8array" | "decoded" | "camera"

interface CellStats {
  meanMs: number
  p95Ms: number
  maxMs: number
}

interface CellResult {
  sourceType: SourceType
  resolution: string
  width: number
  height: number
  k: number
  sampleCount: number
  framesReady: number
  submit: CellStats
  finish: CellStats
  total: CellStats
  errors: string[]
}

function statsOf(samples: number[]): CellStats {
  if (samples.length === 0) {
    return { meanMs: 0, p95Ms: 0, maxMs: 0 }
  }
  const sorted = samples.slice().sort((a, b) => a - b)
  const sum = samples.reduce((a, b) => a + b, 0)
  return {
    meanMs: sum / samples.length,
    p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    maxMs: sorted[sorted.length - 1],
  }
}

interface UploadablesUint8 {
  kind: "uint8array"
  buffers: Uint8Array[]
  width: number
  height: number
}

interface UploadablesDecoder {
  kind: "decoded"
  slots: DecoderSlot[]
  width: number
  height: number
}

interface UploadablesCamera {
  kind: "camera"
  source: CameraSource
  width: number
  height: number
}

type Uploadables = UploadablesUint8 | UploadablesDecoder | UploadablesCamera

function uploadOne(
  gl: WebGL2RenderingContext,
  uploadables: Uploadables,
  index: number,
): void {
  if (uploadables.kind === "uint8array") {
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      uploadables.width,
      uploadables.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      uploadables.buffers[index],
    )
    return
  }
  if (uploadables.kind === "decoded") {
    const frame = uploadables.slots[index].latest
    if (frame === null) {
      return
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame)
    return
  }
  // camera — reuse ring frames (modulo if K > ring length)
  const ringLen = uploadables.source.ring.length
  if (ringLen === 0) {
    return
  }
  const frame = uploadables.source.ring[index % ringLen]
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame)
}

async function runCell(
  gl: WebGL2RenderingContext,
  sourceType: SourceType,
  width: number,
  height: number,
  k: number,
  resolutionLabel: string,
  mipAsset: MipAsset | null,
  cameraSource: CameraSource | null,
): Promise<CellResult> {
  const errors: string[] = []
  // Pre-allocate K textures.
  const textures: WebGLTexture[] = []
  for (let i = 0; i < k; i++) {
    const tex = gl.createTexture()
    if (tex === null) {
      errors.push(`createTexture ${i}`)
      continue
    }
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    textures.push(tex)
  }

  // Build uploadables for this source type.
  let uploadables: Uploadables
  const decoderSlots: DecoderSlot[] = []
  const stopRef: { stop: boolean } = { stop: false }
  const pumpPromises: Promise<void>[] = []
  if (sourceType === "uint8array") {
    const buffers: Uint8Array[] = []
    const byteSize = width * height * 4
    for (let i = 0; i < k; i++) {
      const buf = new Uint8Array(byteSize)
      for (let j = 0; j < byteSize; j += 4) {
        buf[j] = (j + i * 17) & 0xff
        buf[j + 1] = (j + i * 31) & 0xff
        buf[j + 2] = (j + i * 53) & 0xff
        buf[j + 3] = 0xff
      }
      buffers.push(buf)
    }
    uploadables = { kind: "uint8array", buffers, width, height }
  } else if (sourceType === "decoded") {
    if (mipAsset === null) {
      errors.push("no mip asset")
      uploadables = { kind: "decoded", slots: [], width, height }
    } else {
      for (let i = 0; i < k; i++) {
        const slot = makeDecoderSlot(mipAsset)
        decoderSlots.push(slot)
        pumpPromises.push(startSlotPump(slot, mipAsset, stopRef))
      }
      // Wait for slots to produce at least one frame each (or 500ms).
      const waitDeadline = performance.now() + 500
      while (performance.now() < waitDeadline) {
        let allReady = true
        for (const slot of decoderSlots) {
          if (slot.latest === null) {
            allReady = false
            break
          }
        }
        if (allReady) {
          break
        }
        await wait(10)
      }
      uploadables = { kind: "decoded", slots: decoderSlots, width, height }
    }
  } else {
    if (cameraSource === null) {
      errors.push("no camera source")
      uploadables = {
        kind: "camera",
        source: { ring: [], framesObserved: 0, stop() {} },
        width,
        height,
      }
    } else {
      // Wait briefly for the ring buffer to fill.
      const waitDeadline = performance.now() + 1000
      while (performance.now() < waitDeadline && cameraSource.ring.length < Math.min(k, 4)) {
        await wait(20)
      }
      uploadables = { kind: "camera", source: cameraSource, width, height }
    }
  }

  // Count how many slots had a frame ready (sanity).
  let framesReady = 0
  if (uploadables.kind === "decoded") {
    framesReady = uploadables.slots.filter(s => s.latest !== null).length
  } else if (uploadables.kind === "camera") {
    framesReady = uploadables.source.ring.length
  } else {
    framesReady = uploadables.buffers.length
  }

  const submitSamples: number[] = []
  const finishSamples: number[] = []
  const totalSamples: number[] = []
  const deadline = performance.now() + params.cellDurationMs

  while (performance.now() < deadline) {
    const tickStart = performance.now()
    try {
      for (let i = 0; i < k; i++) {
        gl.bindTexture(gl.TEXTURE_2D, textures[i])
        uploadOne(gl, uploadables, i)
      }
    } catch (error) {
      errors.push(`upload: ${error instanceof Error ? error.message : String(error)}`)
      break
    }
    const submitEnd = performance.now()
    try {
      gl.finish()
    } catch (error) {
      errors.push(`finish: ${error instanceof Error ? error.message : String(error)}`)
      break
    }
    const finishEnd = performance.now()
    submitSamples.push(submitEnd - tickStart)
    finishSamples.push(finishEnd - submitEnd)
    totalSamples.push(finishEnd - tickStart)
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  }

  // Stop decoder pumps + clean up textures.
  stopRef.stop = true
  await Promise.race([Promise.all(pumpPromises), wait(500)])
  for (const slot of decoderSlots) {
    slot.stop()
  }
  for (const tex of textures) {
    gl.deleteTexture(tex)
  }

  return {
    sourceType,
    resolution: resolutionLabel,
    width,
    height,
    k,
    sampleCount: submitSamples.length,
    framesReady,
    submit: statsOf(submitSamples),
    finish: statsOf(finishSamples),
    total: statsOf(totalSamples),
    errors,
  }
}

async function run(): Promise<void> {
  status(`upload-real-sources: 3 source types × resolution × K matrix`)

  const canvas = document.createElement("canvas")
  canvas.width = 256
  canvas.height = 256
  canvas.style.cssText =
    "position:fixed;inset:0;width:100vw;height:100vh;z-index:0;display:block;background:#000"
  document.body.appendChild(canvas)
  const glOrNull = canvas.getContext("webgl2")
  if (glOrNull === null) {
    document.body.removeChild(canvas)
    reportResult("upload-real-sources", params, { error: "no webgl2 context" })
    return
  }
  const gl = glOrNull

  status(`recording source clip (${params.sourceSeconds}s)...`)
  const source = await recordProbeInput(
    params.captureResolution.width,
    params.captureResolution.height,
    params.sourceSeconds,
  )
  status(`  got ${source.width}x${source.height}, ${source.chunks.length} chunks`)

  // Pre-transcode AV1 mips for the decoder source.
  const mips: Map<string, MipAsset> = new Map()
  for (const res of params.resolutions) {
    status(`transcoding AV1 mip ${res.label} (${res.width}×${res.height})...`)
    const asset = await transcodeMip(source, res.label, res.width, res.height)
    if (asset === null) {
      status(`  mip ${res.label} transcode failed — skipping`)
      continue
    }
    mips.set(res.label, asset)
    status(`  mip ${res.label}: ${asset.chunks.length} chunks`)
  }

  // Open camera once for the camera tests.
  status(`opening camera for live source...`)
  let cameraNativeWidth = 0
  let cameraNativeHeight = 0
  let camSrc: CameraSource | null = null
  try {
    const { source: s, width, height } = await startCameraSource(Math.max(...params.kValues))
    camSrc = s
    cameraNativeWidth = width
    cameraNativeHeight = height
    status(`  camera native ${cameraNativeWidth}×${cameraNativeHeight}, ring waiting to fill`)
    // Give the ring buffer time to fill before tests start.
    await wait(500)
    status(`  camera ring has ${camSrc.ring.length} frames`)
  } catch (error) {
    status(`  camera open FAILED: ${error instanceof Error ? error.message : String(error)} — skipping camera passes`)
  }

  const results: CellResult[] = []
  let cellIndex = 0
  const totalCells =
    params.resolutions.length * params.kValues.length * 2 +
    (camSrc !== null ? params.kValues.length : 0)

  // Uint8Array sweep.
  for (const res of params.resolutions) {
    for (const k of params.kValues) {
      cellIndex++
      status(`[${cellIndex}/${totalCells}] uint8array ${res.label} K=${k}`)
      const r = await runCell(gl, "uint8array", snap16(res.width), snap16(res.height), k, res.label, null, null)
      results.push(r)
      status(
        `  samples=${r.sampleCount} total mean=${r.total.meanMs.toFixed(2)}ms p95=${r.total.p95Ms.toFixed(2)}ms`,
      )
      await wait(50)
    }
  }
  // Decoded VideoFrame sweep.
  for (const res of params.resolutions) {
    const mip = mips.get(res.label)
    if (mip === undefined) {
      continue
    }
    for (const k of params.kValues) {
      cellIndex++
      status(`[${cellIndex}/${totalCells}] decoded ${res.label} K=${k}`)
      const r = await runCell(gl, "decoded", mip.width, mip.height, k, res.label, mip, null)
      results.push(r)
      status(
        `  samples=${r.sampleCount} framesReady=${r.framesReady}/${k} total mean=${r.total.meanMs.toFixed(2)}ms p95=${r.total.p95Ms.toFixed(2)}ms`,
      )
      await wait(50)
    }
  }
  // Camera VideoFrame sweep.
  if (camSrc !== null) {
    for (const k of params.kValues) {
      cellIndex++
      const label = `${cameraNativeWidth}x${cameraNativeHeight}`
      status(`[${cellIndex}/${totalCells}] camera ${label} K=${k}`)
      const r = await runCell(gl, "camera", cameraNativeWidth, cameraNativeHeight, k, label, null, camSrc)
      results.push(r)
      status(
        `  samples=${r.sampleCount} ringSize=${camSrc.ring.length} total mean=${r.total.meanMs.toFixed(2)}ms p95=${r.total.p95Ms.toFixed(2)}ms`,
      )
      await wait(50)
    }
    camSrc.stop()
  }

  // Free transcoded chunks.
  for (const mip of mips.values()) {
    mip.chunks.length = 0
  }

  document.body.removeChild(canvas)
  status("done.")
  reportResult("upload-real-sources", params, {
    cameraNativeWidth,
    cameraNativeHeight,
    cells: results,
  })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("upload-real-sources", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
