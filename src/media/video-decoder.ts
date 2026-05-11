import { VideoSampleSink, type InputVideoTrack, type VideoSample } from "mediabunny"

export interface VideoSource {
  /** Frame whose [pts, pts+duration) covers `tMicros`, or the closest
   *  earlier sample if not yet available. Sync. Returns null only before
   *  the cache has any samples. */
  frameAt(tMicros: number): VideoSample | null
  /** Reset to the start of the clip — pre-loop hook. */
  reset(): void
  /** Free all cached samples. */
  close(): void
}

/**
 * Pre-decode every sample in the track into an in-memory cache, sorted
 * by timestamp. MVP cells use small resolutions (camera default ~640×480
 * downscaled) and short clips — keeping the whole decoded set in memory
 * is acceptable and lets `frameAt` be a synchronous lookup, suitable for
 * a rAF render loop.
 */
export async function makeVideoSource(track: InputVideoTrack): Promise<VideoSource> {
  const sink = new VideoSampleSink(track)
  const samples: VideoSample[] = []
  for await (const sample of sink.samples()) {
    samples.push(sample)
  }
  // Sink yields in presentation order; defensive sort anyway.
  samples.sort((a, b) => a.timestamp - b.timestamp)

  function frameAt(tMicros: number): VideoSample | null {
    if (samples.length === 0) {
      return null
    }
    const tSeconds = tMicros / 1_000_000
    let best: VideoSample | null = null
    for (const sample of samples) {
      if (sample.timestamp <= tSeconds) {
        best = sample
      } else {
        break
      }
    }
    return best
  }

  function reset() {
    // No-op for pre-decoded cache; frameAt is stateless.
  }

  function close() {
    for (const sample of samples) {
      sample.close()
    }
    samples.length = 0
  }

  return { frameAt, reset, close }
}
