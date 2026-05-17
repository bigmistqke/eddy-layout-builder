import type { Input } from "mediabunny"
import { decodeToAudioBuffer } from "../media/audio-decoder"
import { demuxBlob } from "../media/demuxer"
import { makeBitmapSource, type BitmapSource } from "../media/bitmap-source"
import { logTrace } from "../utils"

export interface Clip {
  cellId: string
  duration: number
  audio: AudioBuffer
  video: BitmapSource
  /** Underlying mediabunny Input — held to keep tracks alive until close. */
  input: Input
}

/**
 * Build a Clip from a recorded Blob: demux, decode audio, pre-decode
 * video samples. Returned Clip is ready for synchronous playback.
 */
export async function blobToClip(cellId: string, blob: Blob): Promise<Clip> {
  logTrace("clip-demux-begin", { cellId, blobSize: blob.size, blobType: blob.type })
  const demuxed = await demuxBlob(blob)
  logTrace("clip-demux-done", { cellId, durationSeconds: demuxed.durationSeconds })
  const [audio, video] = await Promise.all([
    decodeToAudioBuffer(demuxed.audioTrack).then(a => {
      logTrace("clip-audio-decoded", { cellId, duration: a.duration, channels: a.numberOfChannels, sampleRate: a.sampleRate })
      return a
    }),
    makeBitmapSource(demuxed.videoTrack).then(v => {
      logTrace("clip-video-decoded", { cellId })
      return v
    }),
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
