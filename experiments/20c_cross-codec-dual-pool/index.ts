// cross-codec-dual-pool — VP9 HW decoders and AV1 SW decoders
// running concurrently. Tests whether 19d's same-codec HW+SW
// additivity holds when each pool uses a different codec.

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
  passes: [
    { label: "vp9-hw-4", hw: 4, sw: 0 },
    { label: "av1-sw-4", hw: 0, sw: 4 },
    { label: "cross-4+4", hw: 4, sw: 4 },
    { label: "cross-2+4", hw: 2, sw: 4 },
  ],
}

interface TranscodeAsset {
  label: string
  config: VideoDecoderConfig
  chunks: EncodedVideoChunk[]
  encodeFps: number
  bytesPerSecOfContent: number
  errors: string[]
}

async function transcode(
  source: ProbeInput,
  label: string,
  codecString: string,
): Promise<TranscodeAsset | null> {
  const errors: string[] = []
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
    error(error) {
      errors.push(`enc: ${error.message}`)
    },
  })
  try {
    encoder.configure({
      codec: codecString,
      width: source.width,
      height: source.height,
      bitrate,
      framerate: 30,
    })
  } catch (error) {
    encoder.close()
    errors.push(`configure: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }

  const start = performance.now()
  let frameIdx = 0
  const sourceDecoder = new VideoDecoder({
    output(frame) {
      try {
        encoder.encode(frame, { keyFrame: frameIdx === 0 })
      } catch (error) {
        errors.push(`encode-call: ${error instanceof Error ? error.message : String(error)}`)
      }
      frame.close()
      frameIdx++
    },
    error(error) {
      errors.push(`source-dec: ${error.message}`)
    },
  })
  sourceDecoder.configure(source.config)
  for (const chunk of source.chunks) {
    sourceDecoder.decode(chunk)
  }
  await sourceDecoder.flush()
  sourceDecoder.close()
  try {
    await encoder.flush()
  } catch (error) {
    errors.push(`enc-flush: ${error instanceof Error ? error.message : String(error)}`)
  }
  encoder.close()
  const encodeMs = performance.now() - start
  const totalBytes = chunks.reduce((s, c) => s + c.byteLength, 0)
  const contentSeconds = frameIdx / 30
  if (chunks.length === 0 || decoderConfig === null) {
    return null
  }
  return {
    label,
    config: decoderConfig,
    chunks,
    encodeFps: frameIdx / (encodeMs / 1000),
    bytesPerSecOfContent: contentSeconds > 0 ? totalBytes / contentSeconds : 0,
    errors,
  }
}

interface PerDecoderStats {
  id: number
  pool: "vp9-hw" | "av1-sw"
  framesDecoded: number
  fps: number
  firstQuarterFps: number
  lastQuarterFps: number
}

interface PassReport {
  label: string
  hw: number
  sw: number
  aggregateFps: number
  hwPoolFps: number
  swPoolFps: number
  perDecoder: PerDecoderStats[]
  errors: string[]
}

async function runPass(
  hwAsset: TranscodeAsset,
  swAsset: TranscodeAsset,
  pass: (typeof params.passes)[number],
): Promise<PassReport> {
  const errors: string[] = []
  const stopped = { value: false }
  interface Entry {
    decoder: VideoDecoder
    pool: "vp9-hw" | "av1-sw"
    asset: TranscodeAsset
    pref: HardwareAcceleration
    framesDecoded: number
  }
  const slots: Array<{
    pool: "vp9-hw" | "av1-sw"
    asset: TranscodeAsset
    pref: HardwareAcceleration
  }> = [
    ...Array.from({ length: pass.hw }, () => ({
      pool: "vp9-hw" as const,
      asset: hwAsset,
      pref: "prefer-hardware" as HardwareAcceleration,
    })),
    ...Array.from({ length: pass.sw }, () => ({
      pool: "av1-sw" as const,
      asset: swAsset,
      pref: "prefer-software" as HardwareAcceleration,
    })),
  ]
  const entries: Entry[] = slots.map((slot, i) => {
    const entry: Entry = {
      decoder: null as unknown as VideoDecoder,
      pool: slot.pool,
      asset: slot.asset,
      pref: slot.pref,
      framesDecoded: 0,
    }
    entry.decoder = new VideoDecoder({
      output(frame) {
        entry.framesDecoded++
        frame.close()
      },
      error(error) {
        errors.push(`${slot.pool}${i}: ${error.message}`)
      },
    })
    try {
      entry.decoder.configure({ ...slot.asset.config, hardwareAcceleration: slot.pref })
    } catch (error) {
      errors.push(
        `${slot.pool}${i} configure: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return entry
  })

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
      for (const chunk of entry.asset.chunks) {
        if (stopped.value) {
          break
        }
        try {
          entry.decoder.decode(chunk)
        } catch (error) {
          errors.push(`decode: ${error instanceof Error ? error.message : String(error)}`)
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
        entry.decoder.configure({ ...entry.asset.config, hardwareAcceleration: entry.pref })
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

  const perDecoder: PerDecoderStats[] = entries.map((e, i) => ({
    id: i,
    pool: e.pool,
    framesDecoded: e.framesDecoded,
    fps: e.framesDecoded / params.runSeconds,
    firstQuarterFps: snapAt1[i] / (quarterMs / 1000),
    lastQuarterFps: (e.framesDecoded - snapAt3[i]) / (quarterMs / 1000),
  }))
  const hwPoolFps = perDecoder
    .filter(d => d.pool === "vp9-hw")
    .reduce((s, d) => s + d.fps, 0)
  const swPoolFps = perDecoder
    .filter(d => d.pool === "av1-sw")
    .reduce((s, d) => s + d.fps, 0)
  return {
    label: pass.label,
    hw: pass.hw,
    sw: pass.sw,
    aggregateFps: hwPoolFps + swPoolFps,
    hwPoolFps,
    swPoolFps,
    perDecoder,
    errors,
  }
}

async function run(): Promise<void> {
  status(
    `cross-codec-dual-pool: hw=${params.hwCodec.label} sw=${params.swCodec.label} × ${params.passes.length} passes × ${params.runSeconds}s`,
  )
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
    status(`ERROR: transcode failed (hw=${hwAsset !== null} sw=${swAsset !== null})`)
    reportResult("cross-codec-dual-pool", params, {
      error: "transcode failed",
      hwAssetOk: hwAsset !== null,
      swAssetOk: swAsset !== null,
    })
    return
  }
  status(
    `  ${hwAsset.label}: ${hwAsset.chunks.length} chunks, ${hwAsset.bytesPerSecOfContent.toFixed(0)} B/s; ` +
      `${swAsset.label}: ${swAsset.chunks.length} chunks, ${swAsset.bytesPerSecOfContent.toFixed(0)} B/s`,
  )

  const passes: PassReport[] = []
  for (const pass of params.passes) {
    status(`PASS [${pass.label}] HW=${pass.hw} SW=${pass.sw}`)
    const report = await runPass(hwAsset, swAsset, pass)
    passes.push(report)
    status(
      `  aggregate=${report.aggregateFps.toFixed(1)}fps ` +
        `(${params.hwCodec.label}-hw=${report.hwPoolFps.toFixed(1)} ` +
        `${params.swCodec.label}-sw=${report.swPoolFps.toFixed(1)})` +
        (report.errors.length > 0 ? ` errors=${report.errors.length}` : ""),
    )
  }
  status("done.")
  hwAsset.chunks.length = 0
  swAsset.chunks.length = 0
  reportResult("cross-codec-dual-pool", params, { passes })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("cross-codec-dual-pool", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
