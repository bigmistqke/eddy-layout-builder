import { BlobSource, Input, ALL_FORMATS, type InputAudioTrack, type InputVideoTrack } from "mediabunny"
import { logTrace } from "../utils"

export interface DemuxResult {
  input: Input
  audioTrack: InputAudioTrack
  videoTrack: InputVideoTrack
  durationSeconds: number
}

/**
 * Open a recorded Blob and pull out the primary audio + video tracks.
 * Throws if either is missing. The Input must be kept alive as long as
 * the tracks are read — Clip.dispose closes it.
 */
export async function demuxBlob(blob: Blob): Promise<DemuxResult> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  const [audioTrack, videoTrack] = await Promise.all([
    input.getPrimaryAudioTrack(),
    input.getPrimaryVideoTrack(),
  ])
  logTrace("demux-tracks", {
    hasAudio: audioTrack !== null,
    hasVideo: videoTrack !== null,
    audioCodec: audioTrack?.codec ?? null,
    videoCodec: videoTrack?.codec ?? null,
  })
  if (audioTrack === null) {
    throw new Error("demuxBlob: blob has no audio track")
  }
  if (videoTrack === null) {
    throw new Error("demuxBlob: blob has no video track")
  }
  const durationSeconds = await input.computeDuration()
  return { input, audioTrack, videoTrack, durationSeconds }
}
