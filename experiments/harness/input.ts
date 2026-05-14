import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from "mediabunny"
import { wait } from "../../src/utils"

/** Everything one measurement run needs from a single recorded clip. */
export interface ProbeInput {
  /** Decoder config for the recorded track. */
  config: VideoDecoderConfig
  /** Encoded chunks in decode order — chunks[0] is a keyframe. */
  chunks: EncodedVideoChunk[]
  /** Actual coded dimensions of the recording. */
  width: number
  height: number
  /** Dimensions requested from getUserMedia (may differ from actual). */
  requestedWidth: number
  requestedHeight: number
}

/** Cap on chunks pulled from a recording (~20s at 30fps). High enough
 *  for the build-cost sweep, which needs clips of varying length;
 *  shorter-clip experiments never approach it. */
const MAX_CHUNKS = 600

/**
 * Record a fresh VP8 clip from the device camera at the requested
 * resolution, then demux it into EncodedVideoChunks plus the decoder
 * config. Mirrors src/media/capture.ts's MediaRecorder path so the probe
 * measures exactly what this device produces.
 */
export async function recordProbeInput(
  requestedWidth: number,
  requestedHeight: number,
  seconds: number,
): Promise<ProbeInput> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: requestedWidth, height: requestedHeight },
    audio: true,
  })
  const mimeType = "video/webm;codecs=vp8,opus"
  if (!MediaRecorder.isTypeSupported(mimeType)) {
    throw new Error(`recordProbeInput: ${mimeType} unsupported`)
  }
  const recorder = new MediaRecorder(stream, { mimeType })
  const blobParts: Blob[] = []
  recorder.ondataavailable = event => {
    if (event.data.size > 0) {
      blobParts.push(event.data)
    }
  }
  const { promise: stopped, resolve: onStopped } = Promise.withResolvers<void>()
  recorder.onstop = () => {
    onStopped()
  }
  recorder.start()
  await wait(seconds * 1000)
  recorder.stop()
  await stopped
  for (const track of stream.getTracks()) {
    track.stop()
  }
  const blob = new Blob(blobParts, { type: mimeType })

  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  const videoTrack = await input.getPrimaryVideoTrack()
  if (videoTrack === null) {
    throw new Error("recordProbeInput: recording has no video track")
  }
  const config = await videoTrack.getDecoderConfig()
  if (config === null) {
    throw new Error("recordProbeInput: track produced no decoder config")
  }
  const sink = new EncodedPacketSink(videoTrack)
  const chunks: EncodedVideoChunk[] = []
  // A VideoDecoder must be fed from a keyframe. MediaRecorder normally
  // emits one first, but occasionally the demuxed stream leads with
  // delta packets — skip those rather than failing the whole run.
  for await (const packet of sink.packets()) {
    const chunk = packet.toEncodedVideoChunk()
    if (chunks.length === 0 && chunk.type !== "key") {
      continue
    }
    chunks.push(chunk)
    if (chunks.length >= MAX_CHUNKS) {
      break
    }
  }
  if (chunks.length === 0) {
    throw new Error("recordProbeInput: no keyframe found in the recording")
  }
  return {
    config,
    chunks,
    width: videoTrack.codedWidth,
    height: videoTrack.codedHeight,
    requestedWidth,
    requestedHeight,
  }
}
