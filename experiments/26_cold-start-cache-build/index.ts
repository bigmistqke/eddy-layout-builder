// cold-start-cache-build — measures the wall time to decode K AV1
// files from OPFS into raw RGBA frames written back to OPFS, with
// all K cells running in parallel. Models a session-open in the C2
// architecture (AV1 canonical + RGBA working cache).

import { wait } from "../../src/utils"
import { recordProbeInput, type ProbeInput } from "../harness/input"
import { reportResult, status } from "../harness/report"

const params = {
  captureResolution: { width: 1280, height: 720 },
  sourceSeconds: 6,
  framesPerCell: 60,
  bitratePerPixel: 0.1,
  swCodec: { label: "av1", codecString: "av01.0.04M.08" },
  opfsDirName: "26",
  passes: [
    { k: 4, mip: { label: "540p", width: 960, height: 544 } },
    { k: 9, mip: { label: "360p", width: 640, height: 368 } },
    { k: 16, mip: { label: "270p", width: 480, height: 272 } },
    { k: 25, mip: { label: "180p", width: 320, height: 184 } },
  ],
}

const snap16 = (value: number): number => Math.max(16, Math.round(value / 16) * 16)

interface Av1Asset {
  width: number
  height: number
  config: VideoDecoderConfig
  chunks: EncodedVideoChunk[]
  totalBytes: number
}

async function transcodeToAv1(
  source: ProbeInput,
  targetW: number,
  targetH: number,
  maxFrames: number,
): Promise<Av1Asset | null> {
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
      if (frameIdx >= maxFrames) {
        frame.close()
        return
      }
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
    if (frameIdx >= maxFrames) {
      break
    }
    sourceDecoder.decode(chunk)
  }
  try {
    await sourceDecoder.flush()
  } catch {}
  sourceDecoder.close()
  try {
    await encoder.flush()
  } catch {}
  encoder.close()
  if (chunks.length === 0 || decoderConfig === null) {
    return null
  }
  return {
    width,
    height,
    config: decoderConfig,
    chunks,
    totalBytes: chunks.reduce((s, c) => s + c.byteLength, 0),
  }
}

async function writeAv1ToOpfs(
  asset: Av1Asset,
  k: number,
  mipLabel: string,
): Promise<string[]> {
  const root = await navigator.storage.getDirectory()
  const dir = await root.getDirectoryHandle(params.opfsDirName, { create: true })
  const fileNames: string[] = []
  // Serialise chunks: 4-byte length prefix + chunk bytes, repeated.
  const totalLen = asset.chunks.reduce((s, c) => s + 4 + c.byteLength, 0)
  const buf = new Uint8Array(totalLen)
  const view = new DataView(buf.buffer)
  let off = 0
  for (const chunk of asset.chunks) {
    view.setUint32(off, chunk.byteLength, false)
    off += 4
    const tmp = new Uint8Array(chunk.byteLength)
    chunk.copyTo(tmp)
    buf.set(tmp, off)
    off += chunk.byteLength
  }
  for (let cellId = 0; cellId < k; cellId++) {
    const fileName = `${mipLabel}-cell-${cellId}-av1.bin`
    const fileHandle = await dir.getFileHandle(fileName, { create: true })
    const writable = await fileHandle.createWritable({ keepExistingData: false })
    await writable.write(buf)
    await writable.close()
    fileNames.push(fileName)
  }
  return fileNames
}

async function readAv1FromOpfs(
  dirName: string,
  fileName: string,
  config: VideoDecoderConfig,
): Promise<EncodedVideoChunk[]> {
  const root = await navigator.storage.getDirectory()
  const dir = await root.getDirectoryHandle(dirName, { create: false })
  const fileHandle = await dir.getFileHandle(fileName, { create: false })
  const file = await fileHandle.getFile()
  const buf = new Uint8Array(await file.arrayBuffer())
  const view = new DataView(buf.buffer)
  const chunks: EncodedVideoChunk[] = []
  let off = 0
  let timestamp = 0
  while (off + 4 <= buf.byteLength) {
    const len = view.getUint32(off, false)
    off += 4
    if (off + len > buf.byteLength) {
      break
    }
    chunks.push(
      new EncodedVideoChunk({
        type: chunks.length === 0 ? "key" : "delta",
        timestamp,
        data: buf.buffer.slice(off, off + len),
      }),
    )
    off += len
    timestamp += 33333 // 30 fps
  }
  return chunks
}

interface CellResult {
  cellId: number
  framesDecoded: number
  av1Bytes: number
  rgbaBytes: number
  decodeMs: number
  writeMs: number
  totalMs: number
}

async function warmOneCell(
  cellId: number,
  fileName: string,
  config: VideoDecoderConfig,
  width: number,
  height: number,
): Promise<CellResult> {
  const start = performance.now()
  const av1Chunks = await readAv1FromOpfs(params.opfsDirName, fileName, config)
  const av1Bytes = av1Chunks.reduce((s, c) => s + c.byteLength, 0)

  const decodeStart = performance.now()
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext("2d")
  if (context === null) {
    return {
      cellId,
      framesDecoded: 0,
      av1Bytes,
      rgbaBytes: 0,
      decodeMs: 0,
      writeMs: 0,
      totalMs: performance.now() - start,
    }
  }
  const rgbaBytesByFrame: Uint8Array[] = []
  const decoder = new VideoDecoder({
    output(frame) {
      try {
        context.drawImage(frame, 0, 0, width, height)
        const imageData = context.getImageData(0, 0, width, height)
        rgbaBytesByFrame.push(new Uint8Array(imageData.data.buffer.slice(0)))
      } catch {}
      frame.close()
    },
    error() {},
  })
  decoder.configure({ ...config, hardwareAcceleration: "prefer-software" })
  for (const chunk of av1Chunks) {
    decoder.decode(chunk)
  }
  try {
    await decoder.flush()
  } catch {}
  decoder.close()
  const decodeMs = performance.now() - decodeStart

  // Write concatenated RGBA bytes to OPFS.
  const writeStart = performance.now()
  const root = await navigator.storage.getDirectory()
  const dir = await root.getDirectoryHandle(params.opfsDirName, { create: false })
  const fileName2 = fileName.replace("-av1.bin", "-rgba.bin")
  const fileHandle = await dir.getFileHandle(fileName2, { create: true })
  const writable = await fileHandle.createWritable({ keepExistingData: false })
  let rgbaBytes = 0
  for (const frame of rgbaBytesByFrame) {
    await writable.write(frame)
    rgbaBytes += frame.byteLength
  }
  await writable.close()
  const writeMs = performance.now() - writeStart

  return {
    cellId,
    framesDecoded: rgbaBytesByFrame.length,
    av1Bytes,
    rgbaBytes,
    decodeMs,
    writeMs,
    totalMs: performance.now() - start,
  }
}

interface PassResult {
  k: number
  mip: string
  mipWidth: number
  mipHeight: number
  coldStartMs: number
  avgPerCellMs: number
  av1TotalMb: number
  rgbaTotalMb: number
  compressionRatio: number
  perCell: CellResult[]
}

async function cleanupOpfs(dirName: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory()
    await root.removeEntry(dirName, { recursive: true })
  } catch {}
}

async function run(): Promise<void> {
  status(`cold-start-cache-build: ${params.passes.length} K-values`)
  status(`recording source clip (${params.sourceSeconds}s)...`)
  const source = await recordProbeInput(
    params.captureResolution.width,
    params.captureResolution.height,
    params.sourceSeconds,
  )
  status(`  got ${source.width}x${source.height}, ${source.chunks.length} chunks`)

  const results: PassResult[] = []
  for (const pass of params.passes) {
    status(`PASS K=${pass.k} mip=${pass.mip.label} (${pass.mip.width}×${pass.mip.height})`)
    status(`  transcoding source → AV1 mip...`)
    const asset = await transcodeToAv1(source, pass.mip.width, pass.mip.height, params.framesPerCell)
    if (asset === null) {
      status(`  transcode FAILED — skipping`)
      continue
    }
    status(`  AV1 size: ${(asset.totalBytes / 1024).toFixed(0)} KB / cell`)

    status(`  writing K=${pass.k} AV1 files to OPFS (setup, not on hot path)...`)
    const fileNames = await writeAv1ToOpfs(asset, pass.k, pass.mip.label)
    status(`  wrote ${fileNames.length} AV1 files`)

    status(`  COLD-START: K=${pass.k} parallel decode + RGBA write...`)
    const coldStart = performance.now()
    const cellResults = await Promise.all(
      fileNames.map((fn, i) => warmOneCell(i, fn, asset.config, asset.width, asset.height)),
    )
    const coldStartMs = performance.now() - coldStart

    const av1TotalMb = cellResults.reduce((s, c) => s + c.av1Bytes, 0) / 1024 / 1024
    const rgbaTotalMb = cellResults.reduce((s, c) => s + c.rgbaBytes, 0) / 1024 / 1024
    const compression = av1TotalMb > 0 ? rgbaTotalMb / av1TotalMb : 0

    results.push({
      k: pass.k,
      mip: pass.mip.label,
      mipWidth: asset.width,
      mipHeight: asset.height,
      coldStartMs,
      avgPerCellMs: coldStartMs / pass.k,
      av1TotalMb,
      rgbaTotalMb,
      compressionRatio: compression,
      perCell: cellResults,
    })

    status(
      `  cold-start = ${coldStartMs.toFixed(0)}ms (${(coldStartMs / pass.k).toFixed(0)}ms/cell amortised); ` +
        `AV1 ${av1TotalMb.toFixed(2)}MB → RGBA ${rgbaTotalMb.toFixed(1)}MB (${compression.toFixed(0)}× expansion)`,
    )

    // Cleanup before next pass.
    await cleanupOpfs(params.opfsDirName)
    await wait(500)
  }
  status("done.")
  reportResult("cold-start-cache-build", params, { passes: results })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("cold-start-cache-build", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
