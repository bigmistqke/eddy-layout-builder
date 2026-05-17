// device-profile — compact runtime probe. Records ~1 s of VP8,
// probes encoder/decoder support per codec, runs short throughput
// samples, derives a recommendation, emits a portable JSON profile.

import { wait } from "../../src/utils"
import { recordProbeInput, type ProbeInput } from "../harness/input"
import { reportResult, status } from "../harness/report"

const params = {
  captureResolution: { width: 1280, height: 720 },
  sourceSeconds: 1,
  bitratePerPixel: 0.1,
  decodeSampleSeconds: 1,
  comboSampleSeconds: 2,
  maxQueue: 8,
  codecs: [
    { label: "vp8", codecString: "vp8" },
    { label: "vp9", codecString: "vp09.00.10.08" },
    { label: "av1", codecString: "av01.0.04M.08" },
    { label: "h264", codecString: "avc1.42E01E" },
  ],
}

interface EncoderProbe {
  supported: boolean
  hwAcceleration: string | null
  reason: string | null
}

interface DecodeSample {
  supported: boolean
  decodeFps: number
  hwAcceleration: string | null
}

interface CodecProfile {
  label: string
  codecString: string
  encoder: EncoderProbe
  hw: DecodeSample
  sw: DecodeSample
}

async function probeEncoder(
  codecString: string,
  width: number,
  height: number,
  bitrate: number,
): Promise<EncoderProbe> {
  try {
    const result = await VideoEncoder.isConfigSupported({
      codec: codecString,
      width,
      height,
      bitrate,
      framerate: 30,
    })
    return {
      supported: result.supported ?? false,
      hwAcceleration: result.config?.hardwareAcceleration ?? null,
      reason: null,
    }
  } catch (error) {
    return {
      supported: false,
      hwAcceleration: null,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

interface TranscodeAsset {
  config: VideoDecoderConfig
  chunks: EncodedVideoChunk[]
}

async function transcode(
  source: ProbeInput,
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
  return { config: decoderConfig, chunks }
}

async function sampleDecode(
  asset: TranscodeAsset,
  pref: HardwareAcceleration,
  durationSeconds: number,
): Promise<DecodeSample> {
  const probe = await VideoDecoder.isConfigSupported({
    ...asset.config,
    hardwareAcceleration: pref,
  })
  if (!(probe.supported ?? false)) {
    return {
      supported: false,
      decodeFps: 0,
      hwAcceleration: null,
    }
  }
  const stopped = { value: false }
  let frames = 0
  const decoder = new VideoDecoder({
    output(frame) {
      frames++
      frame.close()
    },
    error() {},
  })
  try {
    decoder.configure({ ...asset.config, hardwareAcceleration: pref })
  } catch {
    return { supported: false, decodeFps: 0, hwAcceleration: null }
  }
  const task = (async () => {
    while (!stopped.value) {
      for (const chunk of asset.chunks) {
        if (stopped.value) {
          break
        }
        try {
          decoder.decode(chunk)
        } catch {
          stopped.value = true
          break
        }
        while (decoder.decodeQueueSize > params.maxQueue && !stopped.value) {
          await wait(1)
        }
      }
      if (stopped.value) {
        break
      }
      try {
        await Promise.race([decoder.flush(), wait(2000)])
        if (stopped.value) {
          break
        }
        decoder.reset()
        decoder.configure({ ...asset.config, hardwareAcceleration: pref })
      } catch {
        break
      }
    }
  })()
  await wait(durationSeconds * 1000)
  stopped.value = true
  await Promise.race([task, wait(2000)])
  try {
    decoder.close()
  } catch {}
  return {
    supported: true,
    decodeFps: frames / durationSeconds,
    hwAcceleration: probe.config?.hardwareAcceleration ?? null,
  }
}

async function sampleCombo(
  asset: TranscodeAsset,
  durationSeconds: number,
): Promise<{ aggregateFps: number; hw: number; sw: number }> {
  const stopped = { value: false }
  interface Slot {
    decoder: VideoDecoder
    kind: "hw" | "sw"
    frames: number
  }
  const slots: Array<{ kind: "hw" | "sw"; pref: HardwareAcceleration }> = [
    { kind: "hw", pref: "prefer-hardware" },
    { kind: "hw", pref: "prefer-hardware" },
    { kind: "sw", pref: "prefer-software" },
    { kind: "sw", pref: "prefer-software" },
  ]
  const entries: Slot[] = slots.map(slot => {
    const entry: Slot = {
      decoder: null as unknown as VideoDecoder,
      kind: slot.kind,
      frames: 0,
    }
    entry.decoder = new VideoDecoder({
      output(frame) {
        entry.frames++
        frame.close()
      },
      error() {},
    })
    try {
      entry.decoder.configure({ ...asset.config, hardwareAcceleration: slot.pref })
    } catch {}
    return entry
  })
  const tasks = entries.map(async (entry, idx) => {
    const slot = slots[idx]
    while (!stopped.value) {
      for (const chunk of asset.chunks) {
        if (stopped.value) {
          break
        }
        try {
          entry.decoder.decode(chunk)
        } catch {
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
        await Promise.race([entry.decoder.flush(), wait(2000)])
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
  await wait(durationSeconds * 1000)
  stopped.value = true
  await Promise.race([Promise.all(tasks), wait(2000)])
  for (const entry of entries) {
    try {
      entry.decoder.close()
    } catch {}
  }
  const hw = entries
    .filter(e => e.kind === "hw")
    .reduce((s, e) => s + e.frames / durationSeconds, 0)
  const sw = entries
    .filter(e => e.kind === "sw")
    .reduce((s, e) => s + e.frames / durationSeconds, 0)
  return { aggregateFps: hw + sw, hw, sw }
}

interface Recommendation {
  captureCodec: string
  storageCodec: string
  cacheCodec: string
  comboCodec: string
  comboAggregateFps: number
  estimatedMaxCells: number
}

function deriveRecommendation(codecs: CodecProfile[]): Recommendation {
  // Encoders that can hit ≥ 30 fps in principle (we don't measure
  // encode fps here; assume supported encoders meet realtime — 20 can
  // refine).
  const viableEncoders = codecs.filter(c => c.encoder.supported)
  // Capture preference: vp9 > vp8 > h264 > av1 (av1 encode is rare/slow
  // even when supported).
  const captureOrder = ["vp9", "vp8", "h264", "av1"]
  const captureCodec =
    viableEncoders
      .map(c => c.label)
      .sort((a, b) => captureOrder.indexOf(a) - captureOrder.indexOf(b))[0] ?? "vp8"
  // Storage: fixed canonical for fleet-wide portability.
  const storageCodec = "vp9"
  // Cache: highest decode fps across HW/SW per codec.
  const decodeBest = codecs.map(c => ({
    label: c.label,
    best: Math.max(c.hw.decodeFps, c.sw.decodeFps),
  }))
  const cacheCodec =
    decodeBest.reduce(
      (best, cur) => (cur.best > best.best ? cur : best),
      { label: storageCodec, best: 0 },
    ).label
  // comboCodec is the same as cacheCodec for now (best decode is what
  // we'd run a combo pool on).
  return {
    captureCodec,
    storageCodec,
    cacheCodec,
    comboCodec: cacheCodec,
    comboAggregateFps: 0,
    estimatedMaxCells: 0,
  }
}

async function run(): Promise<void> {
  status(`device-profile probe: ${params.codecs.length} codecs`)
  status(`recording VP8 source clip (${params.sourceSeconds}s)...`)
  const source = await recordProbeInput(
    params.captureResolution.width,
    params.captureResolution.height,
    params.sourceSeconds,
  )
  status(`  got ${source.width}x${source.height}, ${source.chunks.length} chunks`)

  const bitrate = Math.round(
    source.width * source.height * 30 * params.bitratePerPixel,
  )
  const profiles: CodecProfile[] = []
  // Keep one transcode per codec for phase 3.
  const assets = new Map<string, TranscodeAsset>()
  for (const codec of params.codecs) {
    status(`probe ${codec.label}...`)
    const encoder = await probeEncoder(
      codec.codecString,
      source.width,
      source.height,
      bitrate,
    )
    status(`  encoder: supported=${encoder.supported} accel=${encoder.hwAcceleration ?? "-"}`)

    let hw: DecodeSample = { supported: false, decodeFps: 0, hwAcceleration: null }
    let sw: DecodeSample = { supported: false, decodeFps: 0, hwAcceleration: null }
    if (encoder.supported) {
      const asset = await transcode(source, codec.codecString)
      if (asset !== null) {
        assets.set(codec.label, asset)
        hw = await sampleDecode(asset, "prefer-hardware", params.decodeSampleSeconds)
        sw = await sampleDecode(asset, "prefer-software", params.decodeSampleSeconds)
        status(`  decode: hw=${hw.decodeFps.toFixed(0)}fps sw=${sw.decodeFps.toFixed(0)}fps`)
      } else {
        status(`  transcode failed — skipping decode samples`)
      }
    }
    profiles.push({
      label: codec.label,
      codecString: codec.codecString,
      encoder,
      hw,
      sw,
    })
  }

  const recommendation = deriveRecommendation(profiles)
  // Phase 3 — combo headroom on the recommended cache codec.
  const comboAsset = assets.get(recommendation.comboCodec)
  if (comboAsset !== undefined) {
    status(`combo-2+2 sample on ${recommendation.comboCodec} (${params.comboSampleSeconds}s)...`)
    const combo = await sampleCombo(comboAsset, params.comboSampleSeconds)
    // Extrapolate 2+2 → 4+4 linearly. 20b will refine the constant.
    recommendation.comboAggregateFps = combo.aggregateFps * 2
    recommendation.estimatedMaxCells = Math.floor(
      recommendation.comboAggregateFps / 30,
    )
    status(
      `  combo-2+2 = ${combo.aggregateFps.toFixed(0)}fps (hw=${combo.hw.toFixed(0)} sw=${combo.sw.toFixed(0)}); ` +
        `extrapolated combo-4+4 ≈ ${recommendation.comboAggregateFps.toFixed(0)}fps → maxCells ≈ ${recommendation.estimatedMaxCells}`,
    )
  } else {
    status(`no asset for combo codec ${recommendation.comboCodec} — skipping phase 3`)
  }

  status(
    `recommendation: capture=${recommendation.captureCodec} storage=${recommendation.storageCodec} cache=${recommendation.cacheCodec} maxCells≈${recommendation.estimatedMaxCells}`,
  )
  status("done.")

  // Clear chunks before reporting to keep result.json small.
  for (const asset of assets.values()) {
    asset.chunks.length = 0
  }
  reportResult("device-profile", params, {
    codecs: profiles,
    recommendation,
  })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("device-profile", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
