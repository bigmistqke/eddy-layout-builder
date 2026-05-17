// codec-survey — VP8 / VP9 / H.264 / AV1 encode + decode throughput,
// HW and SW. Tests whether the ~150 fps decode ceiling we keep
// hitting is VP8-specific or fundamental on this device.

import { wait } from "../../src/utils"
import { recordProbeInput, type ProbeInput } from "../harness/input"
import { reportResult, status } from "../harness/report"

const params = {
  captureResolution: { width: 1280, height: 720 },
  sourceSeconds: 6,
  /** Per-decoder throughput test length. */
  runSeconds: 6,
  /** Bitrate scaler — same per-pixel rate as harness/composite.ts. */
  bitratePerPixel: 0.1,
  maxQueue: 8,
  /** Codec configurations to probe. Strings are common profile codes
   *  for each codec; the browser may reject some on this device. */
  codecs: [
    { label: "vp8", codecString: "vp8" },
    { label: "vp9", codecString: "vp09.00.10.08" },
    { label: "h264", codecString: "avc1.42E01E" },
    { label: "av1", codecString: "av01.0.04M.08" },
  ],
}

interface ConfigProbe {
  supported: boolean
  actualHardwareAcceleration: string | null
  reason: string | null
}

async function probeEncoder(
  codecString: string,
  width: number,
  height: number,
  bitrate: number,
): Promise<ConfigProbe> {
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
      actualHardwareAcceleration: result.config?.hardwareAcceleration ?? null,
      reason: null,
    }
  } catch (error) {
    return {
      supported: false,
      actualHardwareAcceleration: null,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

async function probeDecoder(
  config: VideoDecoderConfig,
  pref: HardwareAcceleration,
): Promise<ConfigProbe> {
  try {
    const result = await VideoDecoder.isConfigSupported({
      ...config,
      hardwareAcceleration: pref,
    })
    return {
      supported: result.supported ?? false,
      actualHardwareAcceleration: result.config?.hardwareAcceleration ?? null,
      reason: null,
    }
  } catch (error) {
    return {
      supported: false,
      actualHardwareAcceleration: null,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

interface EncodeResult {
  ok: boolean
  encodeMs: number
  encodeFps: number
  framesEncoded: number
  totalBytes: number
  bytesPerSecOfContent: number
  decoderConfig: VideoDecoderConfig | null
  chunks: EncodedVideoChunk[]
  errors: string[]
}

/** Decode the VP8 source, re-encode every frame into the target
 *  codec, collect the encoded chunks. Returns the transcoded asset
 *  + encode timing. */
async function transcode(
  source: ProbeInput,
  codecString: string,
): Promise<EncodeResult> {
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
    return {
      ok: false,
      encodeMs: 0,
      encodeFps: 0,
      framesEncoded: 0,
      totalBytes: 0,
      bytesPerSecOfContent: 0,
      decoderConfig: null,
      chunks: [],
      errors: [`configure: ${error instanceof Error ? error.message : String(error)}`],
    }
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
  return {
    ok: chunks.length > 0 && decoderConfig !== null,
    encodeMs,
    encodeFps: frameIdx / (encodeMs / 1000),
    framesEncoded: frameIdx,
    totalBytes,
    bytesPerSecOfContent: contentSeconds > 0 ? totalBytes / contentSeconds : 0,
    decoderConfig,
    chunks,
    errors,
  }
}

interface DecodeResult {
  ok: boolean
  decodeFps: number
  totalFrames: number
  switchCostMs: number | null
  errors: string[]
}

async function decodeThroughput(
  asset: { config: VideoDecoderConfig; chunks: EncodedVideoChunk[] },
  pref: HardwareAcceleration,
): Promise<DecodeResult> {
  const errors: string[] = []
  let totalFrames = 0
  const stopped = { value: false }
  const decoder = new VideoDecoder({
    output(frame) {
      totalFrames++
      frame.close()
    },
    error(error) {
      errors.push(`dec: ${error.message}`)
    },
  })
  try {
    decoder.configure({ ...asset.config, hardwareAcceleration: pref })
  } catch (error) {
    decoder.close()
    return {
      ok: false,
      decodeFps: 0,
      totalFrames: 0,
      switchCostMs: null,
      errors: [`configure: ${error instanceof Error ? error.message : String(error)}`],
    }
  }
  const task = (async () => {
    while (!stopped.value) {
      for (const chunk of asset.chunks) {
        if (stopped.value) {
          break
        }
        try {
          decoder.decode(chunk)
        } catch (error) {
          errors.push(`decode: ${error instanceof Error ? error.message : String(error)}`)
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
        // Bounded flush — some codecs (AV1 software) can take huge
        // amounts of time to flush; don't let one hang the whole run.
        await Promise.race([
          decoder.flush(),
          wait(3000),
        ])
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
  await wait(params.runSeconds * 1000)
  stopped.value = true
  // Don't await task indefinitely — bounded wait for it to wind down.
  await Promise.race([task, wait(3000)])
  try {
    decoder.close()
  } catch {}

  // Switch cost: fresh decoder, time configure + first keyframe decode.
  // Bounded — slow codecs might never produce a frame in reasonable time.
  let switchCostMs: number | null = null
  try {
    const { promise, resolve, reject } = Promise.withResolvers<VideoFrame | null>()
    const probe = new VideoDecoder({
      output: resolve,
      error: reject,
    })
    probe.configure({ ...asset.config, hardwareAcceleration: pref })
    const start = performance.now()
    probe.decode(asset.chunks[0])
    const timeoutId = window.setTimeout(() => resolve(null), 3000)
    const frame = await promise
    window.clearTimeout(timeoutId)
    if (frame !== null) {
      switchCostMs = performance.now() - start
      frame.close()
    }
    probe.close()
  } catch {
    /* probe failed; leave switchCostMs as null */
  }

  return {
    ok: totalFrames > 0,
    decodeFps: totalFrames / params.runSeconds,
    totalFrames,
    switchCostMs,
    errors,
  }
}

interface CodecReport {
  label: string
  codecString: string
  encoderProbe: ConfigProbe
  decoderProbeHw: ConfigProbe
  decoderProbeSw: ConfigProbe
  encode: EncodeResult | null
  decodeHw: DecodeResult | null
  decodeSw: DecodeResult | null
}

async function surveyCodec(
  source: ProbeInput,
  codec: { label: string; codecString: string },
): Promise<CodecReport> {
  status(`SURVEY [${codec.label}] ${codec.codecString}`)
  const bitrate = Math.round(
    source.width * source.height * 30 * params.bitratePerPixel,
  )
  const encoderProbe = await probeEncoder(
    codec.codecString,
    source.width,
    source.height,
    bitrate,
  )
  status(`  encoder: supported=${encoderProbe.supported} accel=${encoderProbe.actualHardwareAcceleration ?? "-"}`)

  let encode: EncodeResult | null = null
  let decodeHw: DecodeResult | null = null
  let decodeSw: DecodeResult | null = null
  let decoderProbeHw: ConfigProbe = { supported: false, actualHardwareAcceleration: null, reason: "no asset" }
  let decoderProbeSw: ConfigProbe = { supported: false, actualHardwareAcceleration: null, reason: "no asset" }

  if (encoderProbe.supported) {
    encode = await transcode(source, codec.codecString)
    status(
      `  encode: ok=${encode.ok} fps=${encode.encodeFps.toFixed(1)} bytes/s=${encode.bytesPerSecOfContent.toFixed(0)} errors=${encode.errors.length}`,
    )
    if (encode.ok && encode.decoderConfig !== null) {
      const cfg: VideoDecoderConfig = encode.decoderConfig
      decoderProbeHw = await probeDecoder(cfg, "prefer-hardware")
      decoderProbeSw = await probeDecoder(cfg, "prefer-software")
      status(
        `  decoder probes: hw=${decoderProbeHw.actualHardwareAcceleration ?? "-"} sw=${decoderProbeSw.actualHardwareAcceleration ?? "-"}`,
      )
      if (decoderProbeHw.supported) {
        decodeHw = await decodeThroughput(
          { config: cfg, chunks: encode.chunks },
          "prefer-hardware",
        )
        status(
          `  decode HW: fps=${decodeHw.decodeFps.toFixed(1)} switch=${decodeHw.switchCostMs?.toFixed(1) ?? "n/a"}ms`,
        )
      }
      if (decoderProbeSw.supported) {
        decodeSw = await decodeThroughput(
          { config: cfg, chunks: encode.chunks },
          "prefer-software",
        )
        status(
          `  decode SW: fps=${decodeSw.decodeFps.toFixed(1)} switch=${decodeSw.switchCostMs?.toFixed(1) ?? "n/a"}ms`,
        )
      }
      // Free chunks to keep memory bounded across codecs.
      encode.chunks = []
    }
  }

  return {
    label: codec.label,
    codecString: codec.codecString,
    encoderProbe,
    decoderProbeHw,
    decoderProbeSw,
    encode: encode
      ? {
          ...encode,
          // already cleared chunks; keep other fields for report
          chunks: [],
          decoderConfig: encode.decoderConfig
            ? {
                codec: encode.decoderConfig.codec,
                codedWidth: encode.decoderConfig.codedWidth,
                codedHeight: encode.decoderConfig.codedHeight,
              }
            : null,
        }
      : null,
    decodeHw,
    decodeSw,
  }
}

async function run(): Promise<void> {
  status(`codec-survey: ${params.codecs.length} codecs × encode + decode HW/SW`)
  status(`recording VP8 source clip (${params.sourceSeconds}s)...`)
  const source = await recordProbeInput(
    params.captureResolution.width,
    params.captureResolution.height,
    params.sourceSeconds,
  )
  status(`  got ${source.width}x${source.height}, ${source.chunks.length} chunks`)

  const reports: CodecReport[] = []
  for (const codec of params.codecs) {
    reports.push(await surveyCodec(source, codec))
  }
  status("done.")
  reportResult("codec-survey", params, { codecs: reports })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("codec-survey", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
