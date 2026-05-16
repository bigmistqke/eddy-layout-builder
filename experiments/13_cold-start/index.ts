// cold-start — read persisted sub-atlases from OPFS and time to first
// decoded frame. The flow design assumed ~1s; this measures it.

import { wait } from "../../src/utils"
import { composite } from "../harness/composite"
import { recordProbeInput, type ProbeInput } from "../harness/input"
import { reportResult, status } from "../harness/report"

const params = {
  captureResolution: { width: 1280, height: 720 },
  atlasResolution: { width: 540, height: 983 },
  recordSeconds: 4,
  // K=4 parallel matches the flow design's typical sub-atlas count.
  parallelCount: 4,
}

interface AtlasOnDisk {
  configJson: string
  chunkLengths: number[]
  chunkTypes: ("key" | "delta")[]
  chunkTimestamps: number[]
  chunkDurations: (number | null)[]
  totalBytes: number
}

/** Serialize an atlas (config + chunks) into a single Uint8Array.
 *  Custom layout: 4-byte header length, JSON header (config + chunk
 *  metadata), then chunks concatenated. Decoder side reverses. */
function serializeAtlas(input: ProbeInput): Uint8Array {
  const chunkBuffers: Uint8Array[] = []
  const chunkLengths: number[] = []
  const chunkTypes: ("key" | "delta")[] = []
  const chunkTimestamps: number[] = []
  const chunkDurations: (number | null)[] = []
  for (const chunk of input.chunks) {
    const buffer = new Uint8Array(chunk.byteLength)
    chunk.copyTo(buffer)
    chunkBuffers.push(buffer)
    chunkLengths.push(buffer.byteLength)
    chunkTypes.push(chunk.type)
    chunkTimestamps.push(chunk.timestamp)
    chunkDurations.push(chunk.duration ?? null)
  }
  const configJson = JSON.stringify({
    codec: input.config.codec,
    codedWidth: input.config.codedWidth,
    codedHeight: input.config.codedHeight,
  })
  const header = JSON.stringify({
    configJson,
    chunkLengths,
    chunkTypes,
    chunkTimestamps,
    chunkDurations,
  })
  const headerBytes = new TextEncoder().encode(header)
  const headerLen = headerBytes.byteLength
  const totalBytes =
    4 + headerLen + chunkBuffers.reduce((sum, buf) => sum + buf.byteLength, 0)
  const out = new Uint8Array(totalBytes)
  new DataView(out.buffer).setUint32(0, headerLen, true)
  out.set(headerBytes, 4)
  let offset = 4 + headerLen
  for (const buf of chunkBuffers) {
    out.set(buf, offset)
    offset += buf.byteLength
  }
  return out
}

interface DeserializedAtlas {
  config: VideoDecoderConfig
  chunks: EncodedVideoChunk[]
}

function deserializeAtlas(bytes: Uint8Array): DeserializedAtlas {
  const headerLen = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true)
  const header = JSON.parse(
    new TextDecoder().decode(bytes.subarray(4, 4 + headerLen)),
  ) as AtlasOnDisk
  const configRaw = JSON.parse(header.configJson) as {
    codec: string
    codedWidth: number
    codedHeight: number
  }
  const config: VideoDecoderConfig = {
    codec: configRaw.codec,
    codedWidth: configRaw.codedWidth,
    codedHeight: configRaw.codedHeight,
  }
  const chunks: EncodedVideoChunk[] = []
  let offset = 4 + headerLen
  for (let i = 0; i < header.chunkLengths.length; i++) {
    const len = header.chunkLengths[i]
    const data = bytes.slice(offset, offset + len)
    chunks.push(
      new EncodedVideoChunk({
        type: header.chunkTypes[i],
        timestamp: header.chunkTimestamps[i],
        duration: header.chunkDurations[i] ?? undefined,
        data,
      }),
    )
    offset += len
  }
  return { config, chunks }
}

async function writeToOpfs(filename: string, bytes: Uint8Array): Promise<void> {
  const root = await navigator.storage.getDirectory()
  const handle = await root.getFileHandle(filename, { create: true })
  const writable = await handle.createWritable()
  await writable.write(bytes as unknown as BufferSource)
  await writable.close()
}

interface ColdStartTiming {
  /** Bytes on disk. */
  bytes: number
  /** ms from start to OPFS file opened. */
  openMs: number
  /** ms from start to bytes read + deserialized. */
  readMs: number
  /** ms from start to decoder.configure resolved. */
  configureMs: number
  /** ms from start to first decoded frame from decoder.output(). */
  firstFrameMs: number
}

async function coldStart(filename: string): Promise<ColdStartTiming> {
  const t0 = performance.now()
  const root = await navigator.storage.getDirectory()
  const handle = await root.getFileHandle(filename)
  const t1 = performance.now()
  const file = await handle.getFile()
  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  const { config, chunks } = deserializeAtlas(bytes)
  const t2 = performance.now()
  const { promise: firstFrame, resolve: resolveFirstFrame } = Promise.withResolvers<void>()
  const decoder = new VideoDecoder({
    output(frame) {
      frame.close()
      resolveFirstFrame()
    },
    error(error) {
      throw error
    },
  })
  decoder.configure(config)
  const t3 = performance.now()
  decoder.decode(chunks[0])
  await firstFrame
  const t4 = performance.now()
  decoder.close()
  return {
    bytes: bytes.byteLength,
    openMs: t1 - t0,
    readMs: t2 - t0,
    configureMs: t3 - t0,
    firstFrameMs: t4 - t0,
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

  status(`baking atlas (${params.atlasResolution.width}x${params.atlasResolution.height})...`)
  const { output: atlas, compositeMs } = await composite(
    source,
    4,
    4,
    params.atlasResolution.width,
    params.atlasResolution.height,
  )
  status(`  atlas ${atlas.width}x${atlas.height} built in ${compositeMs.toFixed(0)}ms`)

  status(`serializing + writing K=${params.parallelCount} copies to OPFS...`)
  const bytes = serializeAtlas(atlas)
  const filenames: string[] = []
  for (let i = 0; i < params.parallelCount; i++) {
    const name = `cold-start-atlas-${i}.bin`
    await writeToOpfs(name, bytes)
    filenames.push(name)
  }
  status(`  wrote ${params.parallelCount} files × ${bytes.byteLength} bytes`)

  // Drop in-memory references so the cold-start path can't shortcut.
  // (Browser may still cache OPFS file pages, but that's true at boot too.)
  status(`cooling down (release references + idle)...`)
  await wait(500)

  status(`COLD START — single atlas (sequential)...`)
  const single = await coldStart(filenames[0])
  status(
    `  single: bytes=${single.bytes}, open=${single.openMs.toFixed(1)}ms, read=${single.readMs.toFixed(1)}ms, configure=${single.configureMs.toFixed(1)}ms, firstFrame=${single.firstFrameMs.toFixed(1)}ms`,
  )

  status(`COLD START — K=${params.parallelCount} atlases (parallel)...`)
  const t0 = performance.now()
  const parallelTimings = await Promise.all(filenames.map(name => coldStart(name)))
  const wallClockMs = performance.now() - t0
  const maxFirstFrameMs = Math.max(...parallelTimings.map(t => t.firstFrameMs))
  status(
    `  parallel: wallClock=${wallClockMs.toFixed(1)}ms, maxFirstFrame=${maxFirstFrameMs.toFixed(1)}ms`,
  )
  for (let i = 0; i < parallelTimings.length; i++) {
    const t = parallelTimings[i]
    status(
      `    atlas ${i}: open=${t.openMs.toFixed(1)}, read=${t.readMs.toFixed(1)}, configure=${t.configureMs.toFixed(1)}, firstFrame=${t.firstFrameMs.toFixed(1)}`,
    )
  }

  status("done.")
  reportResult("cold-start", params, {
    single,
    parallel: {
      wallClockMs,
      maxFirstFrameMs,
      perAtlas: parallelTimings,
    },
  })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("cold-start", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
