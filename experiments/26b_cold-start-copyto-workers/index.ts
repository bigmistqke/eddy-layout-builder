// cold-start-copyto-workers — 26 with two changes: VideoFrame.copyTo
// instead of canvas + getImageData, and per-cell warm jobs run in
// dedicated workers using SyncAccessHandle for both AV1 read and
// RGBA write.

import { wait } from "../../src/utils"
import { recordProbeInput, type ProbeInput } from "../harness/input"
import { reportResult, status } from "../harness/report"

const params = {
  captureResolution: { width: 1280, height: 720 },
  sourceSeconds: 6,
  framesPerCell: 60,
  bitratePerPixel: 0.1,
  swCodec: { label: "av1", codecString: "av01.0.04M.08" },
  opfsDirName: "26b",
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
  const fileNames: string[] = []
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

interface CellResult {
  cellId: number
  framesProduced: number
  decodeMs: number
  writeMs: number
  totalMs: number
  errors: string[]
}

function spawnWarmWorker(
  cellId: number,
  av1FileName: string,
  rgbaFileName: string,
  config: VideoDecoderConfig,
  width: number,
  height: number,
): Promise<CellResult> {
  const worker = new Worker(
    new URL("./warm-worker.ts", import.meta.url),
    { type: "module" },
  )
  const { promise, resolve } = Promise.withResolvers<CellResult>()
  worker.onmessage = (event: MessageEvent<{
    type: "done"
    cellId: number
    framesProduced: number
    decodeMs: number
    writeMs: number
    totalMs: number
    errors: string[]
  }>) => {
    if (event.data.type === "done") {
      const { framesProduced, decodeMs, writeMs, totalMs, errors } = event.data
      resolve({ cellId, framesProduced, decodeMs, writeMs, totalMs, errors })
      worker.terminate()
    }
  }
  worker.postMessage({
    type: "warm",
    cellId,
    dirName: params.opfsDirName,
    av1FileName,
    rgbaFileName,
    config,
    width,
    height,
  })
  return promise
}

async function getRgbaFileSize(fileName: string): Promise<number> {
  try {
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle(params.opfsDirName, { create: false })
    const fh = await dir.getFileHandle(fileName, { create: false })
    const f = await fh.getFile()
    return f.size
  } catch {
    return 0
  }
}

async function cleanupOpfs(dirName: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory()
    await root.removeEntry(dirName, { recursive: true })
  } catch {}
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

async function run(): Promise<void> {
  status(`cold-start-copyto-workers: ${params.passes.length} K-values`)
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
    status(`  AV1 size: ${(asset.totalBytes / 1024).toFixed(0)} KB / cell (${asset.chunks.length} chunks)`)

    status(`  writing K=${pass.k} AV1 files to OPFS (setup, not on hot path)...`)
    const av1FileNames = await writeAv1ToOpfs(asset, pass.k, pass.mip.label)
    status(`  wrote ${av1FileNames.length} AV1 files`)

    status(`  COLD-START: K=${pass.k} parallel workers (copyTo + SyncAccessHandle write)...`)
    const coldStart = performance.now()
    const cellResults = await Promise.all(
      av1FileNames.map((fn, i) =>
        spawnWarmWorker(
          i,
          fn,
          fn.replace("-av1.bin", "-rgba.bin"),
          asset.config,
          asset.width,
          asset.height,
        ),
      ),
    )
    const coldStartMs = performance.now() - coldStart

    // Read back RGBA file sizes for size accounting.
    let rgbaTotal = 0
    for (const cell of cellResults) {
      const rgbaFn = av1FileNames[cell.cellId].replace("-av1.bin", "-rgba.bin")
      rgbaTotal += await getRgbaFileSize(rgbaFn)
    }
    const av1TotalMb = (asset.totalBytes * pass.k) / 1024 / 1024
    const rgbaTotalMb = rgbaTotal / 1024 / 1024
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

    const avgDecode = cellResults.reduce((s, c) => s + c.decodeMs, 0) / cellResults.length
    const avgWrite = cellResults.reduce((s, c) => s + c.writeMs, 0) / cellResults.length
    const errorCount = cellResults.reduce((s, c) => s + c.errors.length, 0)
    status(
      `  cold-start = ${coldStartMs.toFixed(0)}ms (${(coldStartMs / pass.k).toFixed(0)}ms/cell amort); ` +
        `per-cell avg decode=${avgDecode.toFixed(0)}ms write=${avgWrite.toFixed(0)}ms; ` +
        `AV1 ${av1TotalMb.toFixed(2)}MB → RGBA ${rgbaTotalMb.toFixed(1)}MB (${compression.toFixed(0)}× expansion); ` +
        `errors=${errorCount}`,
    )

    await cleanupOpfs(params.opfsDirName)
    await wait(500)
  }
  status("done.")
  reportResult("cold-start-copyto-workers", params, { passes: results })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("cold-start-copyto-workers", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
