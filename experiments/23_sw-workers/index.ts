// sw-workers — does moving AV1 SW decoders into Web Workers help on
// this device, and does the workerised SW pool restore cross-codec
// additivity that 20c lost?

import { wait } from "../../src/utils"
import { recordProbeInput, type ProbeInput } from "../harness/input"
import { reportResult, status } from "../harness/report"

const params = {
  captureResolution: { width: 1280, height: 720 },
  sourceSeconds: 6,
  runSeconds: 10,
  maxQueue: 8,
  bitratePerPixel: 0.1,
  hwCodec: { label: "vp9", codecString: "vp09.00.10.08" },
  swCodec: { label: "av1", codecString: "av01.0.04M.08" },
}

interface TranscodeAsset {
  label: string
  config: VideoDecoderConfig
  chunks: EncodedVideoChunk[]
  bytesPerSecOfContent: number
}

async function transcode(
  source: ProbeInput,
  label: string,
  codecString: string,
): Promise<TranscodeAsset | null> {
  const chunks: EncodedVideoChunk[] = []
  let decoderConfig: VideoDecoderConfig | null = null
  const bitrate = Math.round(
    source.width * source.height * 30 * params.bitratePerPixel,
  )
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
      codec: codecString,
      width: source.width,
      height: source.height,
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
        encoder.encode(frame, { keyFrame: frameIdx === 0 })
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
  const totalBytes = chunks.reduce((s, c) => s + c.byteLength, 0)
  const contentSeconds = frameIdx / 30
  if (chunks.length === 0 || decoderConfig === null) {
    return null
  }
  return {
    label,
    config: decoderConfig,
    chunks,
    bytesPerSecOfContent: contentSeconds > 0 ? totalBytes / contentSeconds : 0,
  }
}

interface RawChunk {
  type: EncodedVideoChunkType
  timestamp: number
  duration: number | null
  data: ArrayBuffer
}

/** Serialise EncodedVideoChunks for postMessage. The underlying
 *  ArrayBuffers are *copied* (not transferred) so the main asset
 *  keeps a working set — workers each get their own copy. */
function chunksToRaw(chunks: EncodedVideoChunk[]): RawChunk[] {
  return chunks.map(chunk => {
    const buffer = new ArrayBuffer(chunk.byteLength)
    chunk.copyTo(new Uint8Array(buffer))
    return {
      type: chunk.type,
      timestamp: chunk.timestamp,
      duration: chunk.duration ?? null,
      data: buffer,
    }
  })
}

interface WorkerResult {
  framesDecoded: number
  firstQuarterFps: number
  lastQuarterFps: number
  errors: string[]
}

function runOneWorker(
  asset: TranscodeAsset,
  pref: HardwareAcceleration,
): Promise<WorkerResult> {
  const worker = new Worker(
    new URL("./decoder-worker.ts", import.meta.url),
    { type: "module" },
  )
  const { promise, resolve } = Promise.withResolvers<WorkerResult>()
  worker.onmessage = (event: MessageEvent<{ type: "done" } & WorkerResult>) => {
    if (event.data.type === "done") {
      const { framesDecoded, firstQuarterFps, lastQuarterFps, errors } = event.data
      resolve({ framesDecoded, firstQuarterFps, lastQuarterFps, errors })
      worker.terminate()
    }
  }
  const raw = chunksToRaw(asset.chunks)
  worker.postMessage(
    {
      type: "start",
      config: asset.config,
      chunks: raw,
      runSeconds: params.runSeconds,
      maxQueue: params.maxQueue,
      pref,
    },
    raw.map(r => r.data),
  )
  return promise
}

interface DecoderStat {
  id: number
  pool: "vp9-hw" | "av1-sw"
  location: "main" | "worker"
  fps: number
  framesDecoded: number
  firstQuarterFps: number
  lastQuarterFps: number
  errors: string[]
}

interface PassReport {
  label: string
  aggregateFps: number
  hwPoolFps: number
  swPoolFps: number
  perDecoder: DecoderStat[]
}

/** Run a pool of decoders on the main thread for runSeconds. Generic
 *  over codec/pref so we can reuse for vp9-hw and av1-sw. */
async function runMainPool(
  asset: TranscodeAsset,
  pref: HardwareAcceleration,
  pool: "vp9-hw" | "av1-sw",
  n: number,
): Promise<DecoderStat[]> {
  const stopped = { value: false }
  interface Entry {
    decoder: VideoDecoder
    framesDecoded: number
    errors: string[]
  }
  const entries: Entry[] = Array.from({ length: n }, () => ({
    decoder: null as unknown as VideoDecoder,
    framesDecoded: 0,
    errors: [],
  }))
  for (const entry of entries) {
    entry.decoder = new VideoDecoder({
      output(frame) {
        entry.framesDecoded++
        frame.close()
      },
      error(error) {
        entry.errors.push(error.message)
      },
    })
    try {
      entry.decoder.configure({ ...asset.config, hardwareAcceleration: pref })
    } catch (error) {
      entry.errors.push(`configure: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const quarterMs = (params.runSeconds * 1000) / 4
  const snapAt1: number[] = entries.map(() => 0)
  const snapAt3: number[] = entries.map(() => 0)
  const t1 = window.setTimeout(() => {
    for (let i = 0; i < entries.length; i++) {
      snapAt1[i] = entries[i].framesDecoded
    }
  }, quarterMs)
  const t3 = window.setTimeout(() => {
    for (let i = 0; i < entries.length; i++) {
      snapAt3[i] = entries[i].framesDecoded
    }
  }, quarterMs * 3)
  const tasks = entries.map(async entry => {
    while (!stopped.value) {
      for (const chunk of asset.chunks) {
        if (stopped.value) {
          break
        }
        try {
          entry.decoder.decode(chunk)
        } catch (error) {
          entry.errors.push(`decode: ${error instanceof Error ? error.message : String(error)}`)
          stopped.value = true
          break
        }
        while (entry.decoder.decodeQueueSize > params.maxQueue && !stopped.value) {
          await wait(1)
        }
      }
      if (stopped.value) {
        break
      }
      try {
        await Promise.race([entry.decoder.flush(), wait(3000)])
        if (stopped.value) {
          break
        }
        entry.decoder.reset()
        entry.decoder.configure({ ...asset.config, hardwareAcceleration: pref })
      } catch {
        break
      }
    }
  })
  await wait(params.runSeconds * 1000)
  stopped.value = true
  window.clearTimeout(t1)
  window.clearTimeout(t3)
  await Promise.race([Promise.all(tasks), wait(3000)])
  for (const entry of entries) {
    try {
      entry.decoder.close()
    } catch {}
  }
  return entries.map((e, i) => ({
    id: i,
    pool,
    location: "main",
    framesDecoded: e.framesDecoded,
    fps: e.framesDecoded / params.runSeconds,
    firstQuarterFps: snapAt1[i] / (quarterMs / 1000),
    lastQuarterFps: (e.framesDecoded - snapAt3[i]) / (quarterMs / 1000),
    errors: e.errors,
  }))
}

async function runWorkerPool(
  asset: TranscodeAsset,
  pref: HardwareAcceleration,
  pool: "vp9-hw" | "av1-sw",
  n: number,
): Promise<DecoderStat[]> {
  const results = await Promise.all(
    Array.from({ length: n }, () => runOneWorker(asset, pref)),
  )
  return results.map((r, i) => ({
    id: i,
    pool,
    location: "worker",
    framesDecoded: r.framesDecoded,
    fps: r.framesDecoded / params.runSeconds,
    firstQuarterFps: r.firstQuarterFps,
    lastQuarterFps: r.lastQuarterFps,
    errors: r.errors,
  }))
}

function summarise(label: string, perDecoder: DecoderStat[]): PassReport {
  const hwPoolFps = perDecoder.filter(d => d.pool === "vp9-hw").reduce((s, d) => s + d.fps, 0)
  const swPoolFps = perDecoder.filter(d => d.pool === "av1-sw").reduce((s, d) => s + d.fps, 0)
  return {
    label,
    aggregateFps: hwPoolFps + swPoolFps,
    hwPoolFps,
    swPoolFps,
    perDecoder,
  }
}

async function run(): Promise<void> {
  status(`sw-workers: 5 passes × ${params.runSeconds}s`)
  status(`recording VP8 source clip (${params.sourceSeconds}s)...`)
  const source = await recordProbeInput(
    params.captureResolution.width,
    params.captureResolution.height,
    params.sourceSeconds,
  )
  status(`  got ${source.width}x${source.height}, ${source.chunks.length} chunks`)

  status(`transcoding to ${params.hwCodec.label}...`)
  const hwAsset = await transcode(source, params.hwCodec.label, params.hwCodec.codecString)
  status(`transcoding to ${params.swCodec.label}...`)
  const swAsset = await transcode(source, params.swCodec.label, params.swCodec.codecString)
  if (hwAsset === null || swAsset === null) {
    status(`ERROR: transcode failed`)
    reportResult("sw-workers", params, { error: "transcode failed" })
    return
  }
  status(`  ${hwAsset.label}: ${hwAsset.chunks.length} chunks; ${swAsset.label}: ${swAsset.chunks.length} chunks`)

  const passes: PassReport[] = []

  status(`PASS av1-sw-4 main`)
  const swMain = await runMainPool(swAsset, "prefer-software", "av1-sw", 4)
  passes.push(summarise("av1-sw-4-main", swMain))
  status(`  aggregate=${passes[passes.length - 1].aggregateFps.toFixed(1)}fps`)

  status(`PASS av1-sw-4 workers`)
  const swWorkers = await runWorkerPool(swAsset, "prefer-software", "av1-sw", 4)
  passes.push(summarise("av1-sw-4-workers", swWorkers))
  status(`  aggregate=${passes[passes.length - 1].aggregateFps.toFixed(1)}fps`)

  status(`PASS vp9-hw-4 main`)
  const hwMain = await runMainPool(hwAsset, "prefer-hardware", "vp9-hw", 4)
  passes.push(summarise("vp9-hw-4-main", hwMain))
  status(`  aggregate=${passes[passes.length - 1].aggregateFps.toFixed(1)}fps`)

  status(`PASS cross-4+4 all main`)
  const [crossHwMain, crossSwMain] = await Promise.all([
    runMainPool(hwAsset, "prefer-hardware", "vp9-hw", 4),
    runMainPool(swAsset, "prefer-software", "av1-sw", 4),
  ])
  passes.push(summarise("cross-4+4-main", [...crossHwMain, ...crossSwMain]))
  status(
    `  aggregate=${passes[passes.length - 1].aggregateFps.toFixed(1)}fps ` +
      `(hw=${passes[passes.length - 1].hwPoolFps.toFixed(1)} sw=${passes[passes.length - 1].swPoolFps.toFixed(1)})`,
  )

  status(`PASS cross-4+4 hw-main + sw-workers`)
  const [crossHwMain2, crossSwWorkers] = await Promise.all([
    runMainPool(hwAsset, "prefer-hardware", "vp9-hw", 4),
    runWorkerPool(swAsset, "prefer-software", "av1-sw", 4),
  ])
  passes.push(summarise("cross-4+4-hw-main-sw-workers", [...crossHwMain2, ...crossSwWorkers]))
  status(
    `  aggregate=${passes[passes.length - 1].aggregateFps.toFixed(1)}fps ` +
      `(hw=${passes[passes.length - 1].hwPoolFps.toFixed(1)} sw=${passes[passes.length - 1].swPoolFps.toFixed(1)})`,
  )

  status("done.")
  hwAsset.chunks.length = 0
  swAsset.chunks.length = 0
  reportResult("sw-workers", params, { passes })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("sw-workers", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
