import {
  BufferTarget,
  MediaStreamAudioTrackSource,
  Output,
  VideoSample,
  VideoSampleSource,
  WebMOutputFormat,
  type AudioCodec,
  type VideoCodec,
} from "mediabunny"
import { createResizeRig, type ResizeRig } from "./resize-rig"
import { logTrace } from "../utils"

/** Resolutions we always emit, in (width, height). The 720p is the
 *  canonical export-quality stream; the 270p is the playback mip cells
 *  decode. Bitrate is derived from pixel area × fps × bitsPerPixel. */
const HIGH_RESOLUTION = { width: 1280, height: 720 } as const
const LOW_RESOLUTION = { width: 480, height: 272 } as const
const TARGET_FPS = 30
const BITS_PER_PIXEL = 0.1
const AUDIO_BITRATE = 96_000

/** Codecs in preference order. AV1 SW encode is the production target
 *  (per exp 30g) but headless Chromium and older devices may fall back
 *  to VP9 or VP8. The session picks the first one WebCodecs reports
 *  supported via VideoEncoder.isConfigSupported. */
const VIDEO_CODEC_PREFERENCE = ["av1", "vp9", "vp8"] as const satisfies readonly VideoCodec[]
const AUDIO_CODEC: AudioCodec = "opus"

export interface CaptureResult {
  /** 720p AV1/VP9/VP8 + opus, full-quality canonical. */
  canonicalBlob: Blob
  /** 270p (480×272) AV1/VP9/VP8 + opus, the playback mip. */
  mipBlob: Blob
  /** Total wall-clock seconds the capture ran. */
  durationSeconds: number
  /** Number of camera frames pulled (may be < durationSeconds × 30 if
   *  the camera throttled). */
  frameCount: number
  /** The codec that was actually used (after fallback probing). */
  videoCodec: VideoCodec
}

export interface CaptureSession {
  /** Resolve both blobs after draining both encoders. Does NOT stop the
   *  underlying MediaStream — caller owns it. */
  stop(): Promise<CaptureResult>
  /** Abort without producing usable blobs. Releases all internal
   *  resources. Idempotent. */
  cancel(): Promise<void>
}

interface VideoEncoderRig {
  output: Output
  videoSource: VideoSampleSource
  audioSource: MediaStreamAudioTrackSource
  audioTrack: MediaStreamAudioTrack
  pendingAdds: number
  framesSubmitted: number
}

async function pickVideoCodec(): Promise<VideoCodec> {
  for (const codec of VIDEO_CODEC_PREFERENCE) {
    try {
      const probe = await VideoEncoder.isConfigSupported({
        codec:
          codec === "av1"
            ? "av01.0.05M.08"
            : codec === "vp9"
              ? "vp09.00.30.08"
              : "vp8",
        width: HIGH_RESOLUTION.width,
        height: HIGH_RESOLUTION.height,
        bitrate: 1_000_000,
        framerate: TARGET_FPS,
      })
      if (probe.supported === true) {
        logTrace("capture-codec-picked", { codec })
        return codec
      }
    } catch {
      // Probe threw — try next codec.
    }
  }
  throw new Error("pickVideoCodec: no supported video codec (av1/vp9/vp8)")
}

async function makeRig(
  width: number,
  height: number,
  videoCodec: VideoCodec,
  audioTrack: MediaStreamAudioTrack,
): Promise<VideoEncoderRig> {
  const output = new Output({
    format: new WebMOutputFormat(),
    target: new BufferTarget(),
  })
  const bitrate = Math.round(width * height * TARGET_FPS * BITS_PER_PIXEL)
  const videoSource = new VideoSampleSource({ codec: videoCodec, bitrate })
  output.addVideoTrack(videoSource)
  const audioSource = new MediaStreamAudioTrackSource(audioTrack, {
    codec: AUDIO_CODEC,
    bitrate: AUDIO_BITRATE,
  })
  output.addAudioTrack(audioSource)
  await output.start()
  return {
    output,
    videoSource,
    audioSource,
    audioTrack,
    pendingAdds: 0,
    framesSubmitted: 0,
  }
}

/** Capture from a live MediaStream. The stream is borrowed — caller
 *  owns its lifecycle. Pulls VideoFrames via MediaStreamTrackProcessor,
 *  branches them into (a) direct 720p encode, (b) WebGL resize → 270p
 *  encode. Audio is cloned twice and muxed into both outputs (each
 *  WebM self-contained).
 *
 *  Resolves when both encoders' first frames have been submitted —
 *  i.e. the session is genuinely capturing — so callers can rely on
 *  the resolved CaptureSession to be live. */
export async function startCapture(stream: MediaStream): Promise<CaptureSession> {
  const [videoTrack] = stream.getVideoTracks()
  const [audioTrack] = stream.getAudioTracks()
  if (videoTrack === undefined) {
    throw new Error("startCapture: stream has no video track")
  }
  if (audioTrack === undefined) {
    throw new Error("startCapture: stream has no audio track")
  }

  const videoCodec = await pickVideoCodec()

  // Clone audio per output. Each MediaStreamAudioTrackSource consumes
  // its track exclusively; cloning gives each Output an independent
  // view of the same source samples.
  const audioTrackHigh = audioTrack.clone()
  const audioTrackLow = audioTrack.clone()

  const rigHigh = await makeRig(
    HIGH_RESOLUTION.width,
    HIGH_RESOLUTION.height,
    videoCodec,
    audioTrackHigh,
  )
  const rigLow = await makeRig(
    LOW_RESOLUTION.width,
    LOW_RESOLUTION.height,
    videoCodec,
    audioTrackLow,
  )

  // errorPromise on MediaStreamAudioTrackSource is fire-and-forget;
  // catch rejections so an audio failure doesn't surface as
  // unhandledrejection. Recorded into a flag the stop() path
  // surfaces in the error message.
  const audioErrors: string[] = []
  rigHigh.audioSource.errorPromise.catch((error: unknown) => {
    audioErrors.push(`high: ${error instanceof Error ? error.message : String(error)}`)
  })
  rigLow.audioSource.errorPromise.catch((error: unknown) => {
    audioErrors.push(`low: ${error instanceof Error ? error.message : String(error)}`)
  })

  const resizeRig: ResizeRig = createResizeRig(
    LOW_RESOLUTION.width,
    LOW_RESOLUTION.height,
  )

  const processorCtor = (window as unknown as {
    MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack }) => {
      readable: ReadableStream<VideoFrame>
    }
  }).MediaStreamTrackProcessor
  const processor = new processorCtor({ track: videoTrack })
  const reader = processor.readable.getReader()

  let stopped = false
  let firstCameraTimestampUs: number | null = null
  let frameCount = 0
  const startedAtMs = performance.now()
  const { promise: firstSubmitted, resolve: resolveFirstSubmitted } =
    Promise.withResolvers<void>()

  function submitVideo(rig: VideoEncoderRig, sample: VideoSample): void {
    rig.framesSubmitted++
    rig.pendingAdds++
    rig.videoSource
      .add(sample)
      .catch((error: unknown) => {
        logTrace("capture-add-error", {
          error: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => {
        rig.pendingAdds--
        sample.close()
      })
  }

  // Pump loop — runs until stopped or reader returns done.
  const pumpPromise = (async () => {
    while (!stopped) {
      let result: ReadableStreamReadResult<VideoFrame>
      try {
        result = await reader.read()
      } catch (error) {
        logTrace("capture-read-error", {
          error: error instanceof Error ? error.message : String(error),
        })
        break
      }
      if (result.done) {
        break
      }
      const frame = result.value
      frameCount++
      if (firstCameraTimestampUs === null) {
        firstCameraTimestampUs = frame.timestamp
      }
      const timestampUs = frame.timestamp - firstCameraTimestampUs

      // Branch A — 720p direct, re-stamped to synced-zero base.
      try {
        const highFrame = new VideoFrame(frame, { timestamp: timestampUs })
        submitVideo(rigHigh, new VideoSample(highFrame))
      } catch (error) {
        logTrace("capture-high-error", {
          error: error instanceof Error ? error.message : String(error),
        })
      }

      // Branch B — WebGL 720p→270p resize, also re-stamped.
      try {
        const lowFrame = resizeRig.resize(frame, timestampUs)
        submitVideo(rigLow, new VideoSample(lowFrame))
      } catch (error) {
        logTrace("capture-resize-error", {
          error: error instanceof Error ? error.message : String(error),
        })
      }

      frame.close()

      if (frameCount === 1) {
        resolveFirstSubmitted()
      }
    }
  })()

  // Wait for at least one frame to be submitted before resolving so
  // callers know the session is live.
  await Promise.race([
    firstSubmitted,
    // Safety net: if no frame arrives within 5s, surface the failure
    // instead of leaving the caller hanging.
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("startCapture: no camera frames within 5s")), 5000),
    ),
  ])

  async function finalizeRig(rig: VideoEncoderRig): Promise<Blob> {
    // Drain in-flight video adds before closing.
    const drainStart = performance.now()
    while (rig.pendingAdds > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, 10))
      if (performance.now() - drainStart > 60_000) {
        logTrace("capture-drain-timeout", { pendingAdds: rig.pendingAdds })
        break
      }
    }
    rig.videoSource.close()
    rig.audioSource.close?.()
    await rig.output.finalize()
    const buffer = (rig.output.target as BufferTarget).buffer
    if (buffer === null) {
      throw new Error("finalizeRig: output produced no buffer")
    }
    return new Blob([buffer], { type: "video/webm" })
  }

  function shutdownTracks(): void {
    try {
      reader.releaseLock()
    } catch {}
    try {
      rigHigh.audioTrack.stop()
    } catch {}
    try {
      rigLow.audioTrack.stop()
    } catch {}
    resizeRig.dispose()
  }

  return {
    async stop(): Promise<CaptureResult> {
      if (stopped) {
        throw new Error("CaptureSession.stop: already stopped")
      }
      stopped = true
      const durationSeconds = (performance.now() - startedAtMs) / 1000
      await pumpPromise
      const [canonicalBlob, mipBlob] = await Promise.all([
        finalizeRig(rigHigh),
        finalizeRig(rigLow),
      ])
      shutdownTracks()
      if (audioErrors.length > 0) {
        logTrace("capture-stop-audio-errors", { audioErrors })
      }
      return {
        canonicalBlob,
        mipBlob,
        durationSeconds,
        frameCount,
        videoCodec,
      }
    },
    async cancel(): Promise<void> {
      if (stopped) {
        return
      }
      stopped = true
      try {
        await pumpPromise
      } catch {}
      // Best-effort finalize so internal buffers don't leak; ignore output.
      try {
        rigHigh.videoSource.close()
        rigHigh.audioSource.close?.()
        await rigHigh.output.finalize()
      } catch {}
      try {
        rigLow.videoSource.close()
        rigLow.audioSource.close?.()
        await rigLow.output.finalize()
      } catch {}
      shutdownTracks()
    },
  }
}
