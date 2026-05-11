import type { Input } from "mediabunny"
import { decodeToAudioBuffer } from "../media/audio-decoder"
import { demuxBlob } from "../media/demuxer"
import { makeVideoSource, type VideoSource } from "../media/video-decoder"

export interface Clip {
  cellId: string
  duration: number
  audio: AudioBuffer
  video: VideoSource
  /** Underlying mediabunny Input — held to keep tracks alive until close. */
  input: Input
}

/**
 * Build a Clip from a recorded Blob: demux, decode audio, pre-decode
 * video samples. Returned Clip is ready for synchronous playback.
 */
export async function blobToClip(cellId: string, blob: Blob): Promise<Clip> {
  const demuxed = await demuxBlob(blob)
  const [audio, video] = await Promise.all([
    decodeToAudioBuffer(demuxed.audioTrack),
    makeVideoSource(demuxed.videoTrack),
  ])
  return {
    cellId,
    duration: Math.max(audio.duration, demuxed.durationSeconds),
    audio,
    video,
    input: demuxed.input,
  }
}

export function disposeClip(clip: Clip): void {
  clip.video.close()
}
