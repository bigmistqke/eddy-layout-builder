import type { Input } from "mediabunny"
import { decodeToAudioBuffer } from "../media/audio-decoder"
import { demuxBlob } from "../media/demuxer"
import { makeBitmapSource, type BitmapCacheMetadata, type BitmapSource } from "../media/bitmap-source"
import { rgbaCacheExists } from "../storage/rgba-cache"
import { logTrace } from "../utils"

export interface Clip {
  cellId: string
  /** Per-recording uuid. Distinct from cellId so re-recording the same
   *  cell allocates a fresh rgba cache file, sidestepping the OPFS
   *  SyncAccessHandle lock held by the previous clip's reader worker. */
  clipId: string
  duration: number
  audio: AudioBuffer
  video: BitmapSource
  /** Width/height/totalFrames/sourceFps of the rgba cache backing
   *  `video`. Used by the projects store to persist into CellRecord
   *  so the hot path can read these without re-decoding. */
  videoCacheMetadata: BitmapCacheMetadata
  /** Underlying mediabunny Input — held to keep tracks alive until close. */
  input: Input
}

export interface BlobToClipOptions {
  /** Reuse this clipId from the persisted manifest instead of
   *  allocating a fresh one. Required for the hot path; the rgba
   *  cache file is keyed by this id. */
  persistedClipId?: string
  /** If the rgba cache file `<persistedClipId>.bin` exists, skip the
   *  video demux + decode and spawn the reader directly using this
   *  metadata. Audio is always decoded from the blob (audio doesn't
   *  cache; the AudioBuffer is built per-load). */
  hotMetadata?: BitmapCacheMetadata
}

/**
 * Build a Clip from a recorded Blob.
 *
 * Cold path (no options): demux, decode audio, decode video, write rgba
 * cache, return clip with fresh clipId.
 *
 * Hot path (persistedClipId + hotMetadata, cache file present): demux
 * audio only, skip video decode, spawn reader from existing rgba cache.
 * Used by project reload — saves ~1 s per cell.
 */
export async function blobToClip(
  cellId: string,
  blob: Blob,
  options: BlobToClipOptions = {},
): Promise<Clip> {
  const persistedClipId = options.persistedClipId
  const hotMetadata = options.hotMetadata
  const canHotStart =
    persistedClipId !== undefined &&
    hotMetadata !== undefined &&
    (await rgbaCacheExists(persistedClipId))

  if (canHotStart) {
    logTrace("clip-hot-begin", { cellId, clipId: persistedClipId })
    const demuxed = await demuxBlob(blob)
    const [audio, videoResult] = await Promise.all([
      decodeToAudioBuffer(demuxed.audioTrack),
      makeBitmapSource(null, persistedClipId, hotMetadata),
    ])
    return {
      cellId,
      clipId: persistedClipId,
      duration: Math.max(audio.duration, demuxed.durationSeconds),
      audio,
      video: videoResult.source,
      videoCacheMetadata: videoResult.metadata,
      input: demuxed.input,
    }
  }

  // Cold path.
  logTrace("clip-cold-begin", { cellId, blobSize: blob.size, blobType: blob.type })
  const demuxed = await demuxBlob(blob)
  logTrace("clip-demux-done", { cellId, durationSeconds: demuxed.durationSeconds })
  const clipId = persistedClipId ?? crypto.randomUUID()
  const [audio, videoResult] = await Promise.all([
    decodeToAudioBuffer(demuxed.audioTrack).then(a => {
      logTrace("clip-audio-decoded", { cellId, duration: a.duration, channels: a.numberOfChannels, sampleRate: a.sampleRate })
      return a
    }),
    makeBitmapSource(demuxed.videoTrack, clipId).then(result => {
      logTrace("clip-video-decoded", { cellId, clipId, ...result.metadata })
      return result
    }),
  ])
  return {
    cellId,
    clipId,
    duration: Math.max(audio.duration, demuxed.durationSeconds),
    audio,
    video: videoResult.source,
    videoCacheMetadata: videoResult.metadata,
    input: demuxed.input,
  }
}

export function disposeClip(clip: Clip): void {
  clip.video.close()
}
