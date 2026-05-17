import { VideoSampleSink, type InputVideoTrack } from "mediabunny"
import { logTrace } from "../utils"

export interface BitmapFrame {
  /** Tightly-packed RGBA8 bytes, row-major (width × height × 4). */
  bytes: Uint8Array
  width: number
  height: number
}

export interface BitmapSource {
  /** Returns the most recently advanced-to frame, or null before the
   *  first frame is ready. The returned bytes reference an internal
   *  buffer — callers must consume them within the same tick. */
  latestFrame(): BitmapFrame | null
  /** Advance the internal cursor to the frame nearest to tSeconds.
   *  Called from the render loop or transport tick. Idempotent for
   *  the same tSeconds. */
  seek(tSeconds: number): void
  /** Clear the cursor; latestFrame() returns null until the next seek(). */
  reset(): void
  /** Release internal buffers / readers. Idempotent. */
  close(): void
}

interface CachedRgbaFrame {
  /** PTS in seconds. */
  timestamp: number
  bytes: Uint8Array
  width: number
  height: number
}

export async function makeBitmapSource(track: InputVideoTrack): Promise<BitmapSource> {
  logTrace("bitmap-source-begin", { codec: track.codec })
  const sink = new VideoSampleSink(track)
  const frames: CachedRgbaFrame[] = []
  let lastLog = performance.now()
  for await (const sample of sink.samples()) {
    const videoFrame = sample.toVideoFrame()
    try {
      const width = videoFrame.displayWidth
      const height = videoFrame.displayHeight
      const bytes = new Uint8Array(width * height * 4)
      await videoFrame.copyTo(bytes, { format: "RGBA" })
      const timestamp = sample.timestamp
      frames.push({ timestamp, bytes, width, height })
      const now = performance.now()
      if (now - lastLog > 250 || frames.length <= 3) {
        logTrace("bitmap-source-sample", { count: frames.length, ts: timestamp })
        lastLog = now
      }
    } finally {
      videoFrame.close()
      sample.close()
    }
  }
  logTrace("bitmap-source-done", { count: frames.length })
  // VideoSampleSink yields in decode order, which is NOT presentation
  // order for B-frame codecs. Sort by PTS so seek() can walk in time.
  frames.sort((a, b) => a.timestamp - b.timestamp)

  let cursor: CachedRgbaFrame | null = null

  function seek(tSeconds: number): void {
    if (frames.length === 0) {
      cursor = null
      return
    }
    let best: CachedRgbaFrame | null = null
    for (const frame of frames) {
      if (frame.timestamp <= tSeconds) {
        best = frame
      } else {
        break
      }
    }
    // Snap to first frame when t is before everything (first frame's
    // PTS is often slightly > 0; see deleted video-decoder.ts).
    cursor = best ?? frames[0]
  }

  function latestFrame(): BitmapFrame | null {
    if (cursor === null) {
      return null
    }
    return { bytes: cursor.bytes, width: cursor.width, height: cursor.height }
  }

  function reset(): void {
    cursor = null
  }

  function close(): void {
    frames.length = 0
    cursor = null
  }

  return { latestFrame, seek, reset, close }
}

export function makeCameraBitmapSource(stream: MediaStream): BitmapSource {
  const [track] = stream.getVideoTracks()
  if (track === undefined) {
    throw new Error("makeCameraBitmapSource: stream has no video track")
  }
  // MediaStreamTrackProcessor isn't in all TS lib defs.
  const Ctor = (window as unknown as {
    MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack }) => {
      readable: ReadableStream<VideoFrame>
    }
  }).MediaStreamTrackProcessor
  const processor = new Ctor({ track })
  const reader = processor.readable.getReader()

  let latest: BitmapFrame | null = null
  let stopped = false

  ;(async () => {
    while (!stopped) {
      const { value, done } = await reader.read()
      if (done) {
        break
      }
      const width = value.displayWidth
      const height = value.displayHeight
      // Reuse the buffer if dimensions are unchanged; otherwise allocate.
      const byteLength = width * height * 4
      const bytes: Uint8Array =
        latest !== null && latest.bytes.byteLength === byteLength
          ? latest.bytes
          : new Uint8Array(byteLength)
      try {
        await value.copyTo(bytes, { format: "RGBA" })
        latest = { bytes, width, height }
      } catch (error) {
        // copyTo can race close(); drop the frame. Trace in case
        // it's actually a real error (format unsupported, OOM, …).
        logTrace("camera-bitmap-copyTo-dropped", {
          message: error instanceof Error ? error.message : String(error),
        })
      }
      value.close()
    }
    try {
      reader.releaseLock()
    } catch {}
  })()

  return {
    latestFrame(): BitmapFrame | null {
      return latest
    },
    seek(_tSeconds: number): void {
      // Camera is always "live"; no seek concept.
    },
    reset(): void {
      // No-op for live camera.
    },
    close(): void {
      // Releases the reader; caller still owns the MediaStreamTrack
      // (call track.stop() separately to release the camera).
      stopped = true
      // Force any pending reader.read() to resolve {done: true}.
      // Without this, a stalled camera would hold the reader lock
      // indefinitely after close().
      try {
        reader.cancel()
      } catch {}
      latest = null
    },
  }
}
