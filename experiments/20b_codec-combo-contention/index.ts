// codec-combo-contention — per-codec HW+SW combo decoder pool.
// Extends 19d (VP8) to VP9 + AV1 to confirm whether each codec's
// solo throughput (per 20) survives 4×HW + 4×SW contention.

import { wait } from "../../src/utils"
import { recordProbeInput, type ProbeInput } from "../harness/input"
import { reportResult, status } from "../harness/report"

const params = {
  captureResolution: { width: 1280, height: 720 },
  sourceSeconds: 6,
  runSeconds: 10,
  maxQueue: 8,
  bitratePerPixel: 0.1,
  codecs: [
    { label: "vp8", codecString: "vp8" },
    { label: "vp9", codecString: "vp09.00.10.08" },
    { label: "av1", codecString: "av01.0.04M.08" },
  ],
  passes: [
    { label: "hw-4", hw: 4, sw: 0 },
    { label: "sw-4", hw: 0, sw: 4 },
    { label: "combo-4+4", hw: 4, sw: 4 },
  ],
}

interface TranscodeAsset {
  config: VideoDecoderConfig
  chunks: EncodedVideoChunk[]
  encodeFps: number
  bytesPerSecOfContent: number
  errors: string[]
}

async function transcode(
  source: ProbeInput,
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
    config: decoderConfig,
    chunks,
    encodeFps: frameIdx / (encodeMs / 1000),
    bytesPerSecOfContent: contentSeconds > 0 ? totalBytes / contentSeconds : 0,
    errors,
  }
}

interface PerDecoderStats {
  id: number
  kind: "hw" | "sw"
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
  hwAggregateFps: number
  swAggregateFps: number
  perDecoder: PerDecoderStats[]
  errors: string[]
}

async function runPass(
  asset: TranscodeAsset,
  pass: (typeof params.passes)[number],
): Promise<PassReport> {
  const errors: string[] = []
  const stopped = { value: false }
  interface Entry {
    decoder: VideoDecoder
    kind: "hw" | "sw"
    framesDecoded: number
  }
  const slots: Array<{ kind: "hw" | "sw"; pref: HardwareAcceleration }> = [
    ...Array.from({ length: pass.hw }, () => ({
      kind: "hw" as const,
      pref: "prefer-hardware" as HardwareAcceleration,
    })),
    ...Array.from({ length: pass.sw }, () => ({
      kind: "sw" as const,
      pref: "prefer-software" as HardwareAcceleration,
    })),
  ]
  const entries: Entry[] = slots.map((slot, i) => {
    const entry: Entry = {
      decoder: null as unknown as VideoDecoder,
      kind: slot.kind,
      framesDecoded: 0,
    }
    entry.decoder = new VideoDecoder({
      output(frame) {
        entry.framesDecoded++
        frame.close()
      },
      error(error) {
        errors.push(`${slot.kind}${i}: ${error.message}`)
      },
    })
    try {
      entry.decoder.configure({ ...asset.config, hardwareAcceleration: slot.pref })
    } catch (error) {
      errors.push(
        `${slot.kind}${i} configure: ${error instanceof Error ? error.message : String(error)}`,
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

  const tasks = entries.map(async (entry, idx) => {
    const slot = slots[idx]
    while (!stopped.value) {
      for (const chunk of asset.chunks) {
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
        entry.decoder.configure({ ...asset.config, hardwareAcceleration: slot.pref })
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
    kind: e.kind,
    framesDecoded: e.framesDecoded,
    fps: e.framesDecoded / params.runSeconds,
    firstQuarterFps: snapAt1[i] / (quarterMs / 1000),
    lastQuarterFps: (e.framesDecoded - snapAt3[i]) / (quarterMs / 1000),
  }))
  const hwAggregateFps = perDecoder
    .filter(d => d.kind === "hw")
    .reduce((s, d) => s + d.fps, 0)
  const swAggregateFps = perDecoder
    .filter(d => d.kind === "sw")
    .reduce((s, d) => s + d.fps, 0)
  return {
    label: pass.label,
    hw: pass.hw,
    sw: pass.sw,
    aggregateFps: hwAggregateFps + swAggregateFps,
    hwAggregateFps,
    swAggregateFps,
    perDecoder,
    errors,
  }
}

interface CodecComboReport {
  label: string
  codecString: string
  transcodeOk: boolean
  encodeFps: number
  bytesPerSecOfContent: number
  passes: PassReport[]
  errors: string[]
}

async function surveyCodec(
  source: ProbeInput,
  codec: { label: string; codecString: string },
): Promise<CodecComboReport> {
  status(`SURVEY [${codec.label}] ${codec.codecString}`)
  const asset = await transcode(source, codec.codecString)
  if (asset === null) {
    status(`  transcode failed — skipping passes`)
    return {
      label: codec.label,
      codecString: codec.codecString,
      transcodeOk: false,
      encodeFps: 0,
      bytesPerSecOfContent: 0,
      passes: [],
      errors: ["transcode failed"],
    }
  }
  status(
    `  transcode ok: encodeFps=${asset.encodeFps.toFixed(1)} bytes/s=${asset.bytesPerSecOfContent.toFixed(0)} chunks=${asset.chunks.length}`,
  )
  // Probe HW/SW availability once so we can skip passes that would
  // cascade-fail (e.g. AV1 has no HW path on this device — running
  // a `prefer-hardware` configure trips the entire decoder slot and
  // takes neighbouring SW slots down with it).
  const hwProbe = await VideoDecoder.isConfigSupported({
    ...asset.config,
    hardwareAcceleration: "prefer-hardware",
  })
  const swProbe = await VideoDecoder.isConfigSupported({
    ...asset.config,
    hardwareAcceleration: "prefer-software",
  })
  const hwAvailable = hwProbe.supported ?? false
  const swAvailable = swProbe.supported ?? false
  status(`  decoder paths: hw=${hwAvailable} sw=${swAvailable}`)

  const passes: PassReport[] = []
  for (const pass of params.passes) {
    if (pass.hw > 0 && !hwAvailable) {
      status(`  SKIP [${pass.label}] — no HW path`)
      continue
    }
    if (pass.sw > 0 && !swAvailable) {
      status(`  SKIP [${pass.label}] — no SW path`)
      continue
    }
    status(`  PASS [${pass.label}] HW=${pass.hw} SW=${pass.sw}`)
    const report = await runPass(asset, pass)
    passes.push(report)
    status(
      `    aggregate=${report.aggregateFps.toFixed(1)}fps ` +
        `(hw=${report.hwAggregateFps.toFixed(1)} sw=${report.swAggregateFps.toFixed(1)})` +
        (report.errors.length > 0 ? ` errors=${report.errors.length}` : ""),
    )
  }
  // Free chunks to keep memory bounded across codecs.
  asset.chunks.length = 0
  return {
    label: codec.label,
    codecString: codec.codecString,
    transcodeOk: true,
    encodeFps: asset.encodeFps,
    bytesPerSecOfContent: asset.bytesPerSecOfContent,
    passes,
    errors: asset.errors,
  }
}

async function run(): Promise<void> {
  status(`codec-combo-contention: ${params.codecs.length} codecs × ${params.passes.length} passes`)
  status(`recording VP8 source clip (${params.sourceSeconds}s)...`)
  const source = await recordProbeInput(
    params.captureResolution.width,
    params.captureResolution.height,
    params.sourceSeconds,
  )
  status(`  got ${source.width}x${source.height}, ${source.chunks.length} chunks`)

  const reports: CodecComboReport[] = []
  for (const codec of params.codecs) {
    reports.push(await surveyCodec(source, codec))
  }
  status("done.")
  reportResult("codec-combo-contention", params, { codecs: reports })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("codec-combo-contention", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
