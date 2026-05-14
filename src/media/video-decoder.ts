import { VideoSampleSink, type InputVideoTrack } from "mediabunny"
import { logTrace } from "../utils"

export interface VideoSource {
  /** Frame whose [pts, pts+duration) covers `tMicros`, or the closest
   *  earlier sample if not yet available. Sync. Returns null only before
   *  the cache has any samples. */
  frameAt(tMicros: number): ImageBitmap | null
  /** Reset to the start of the clip — pre-loop hook. */
  reset(): void
  /** Free all cached bitmaps. */
  close(): void
}

interface CachedFrame {
  timestamp: number
  bitmap: ImageBitmap
}

/**
 * Pre-decode every sample in the track into an in-memory cache, sorted
 * by timestamp. MVP cells use small resolutions (camera default ~640×480
 * downscaled) and short clips — keeping the whole decoded set in memory
 * is acceptable and lets `frameAt` be a synchronous lookup, suitable for
 * a rAF render loop.
 *
 * Each decoded sample is converted to an `ImageBitmap` immediately and
 * the underlying `VideoFrame` closed. WebCodecs on Android caps the
 * number of live VideoFrames at ~4; without this conversion the
 * decoder's output queue saturates after a few frames and the iterator
 * hangs with no error. ImageBitmap is uncapped and accepted by
 * texImage2D, so the renderer path is unchanged.
 */
export async function makeVideoSource(track: InputVideoTrack): Promise<VideoSource> {
  logTrace("video-decoder-begin", { codec: track.codec })
  const sink = new VideoSampleSink(track)
  const frames: CachedFrame[] = []
  let lastLog = performance.now()
  for await (const sample of sink.samples()) {
    const videoFrame = sample.toVideoFrame()
    const bitmap = await createImageBitmap(videoFrame)
    videoFrame.close()
    const timestamp = sample.timestamp
    sample.close()
    frames.push({ timestamp, bitmap })
    const now = performance.now()
    if (now - lastLog > 250 || frames.length <= 3) {
      logTrace("video-decoder-sample", { count: frames.length, ts: sample.timestamp })
      lastLog = now
    }
  }
  logTrace("video-decoder-done", { count: frames.length })
  // Sink yields in presentation order; defensive sort anyway.
  frames.sort((a, b) => a.timestamp - b.timestamp)

  function frameAt(tMicros: number): ImageBitmap | null {
    if (frames.length === 0) {
      return null
    }
    const tSeconds = tMicros / 1_000_000
    let best: CachedFrame | null = null
    for (const frame of frames) {
      if (frame.timestamp <= tSeconds) {
        best = frame
      } else {
        break
      }
    }
    // Snap to the first frame when t is before everything (the first
    // frame's PTS is often slightly > 0, e.g. 0.033 at 30fps, which
    // would otherwise leave a color-only flash at the loop boundary).
    return (best ?? frames[0]).bitmap
  }

  function reset() {
    // No-op for pre-decoded cache; frameAt is stateless.
  }

  function close() {
    for (const frame of frames) {
      frame.bitmap.close()
    }
    frames.length = 0
  }

  return { frameAt, reset, close }
}
