import { VideoSampleSink, type InputVideoTrack } from "mediabunny"
import { deleteRgbaCache, writeRgbaCache } from "../storage/rgba-cache"
import { logTrace, wait } from "../utils"

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

export async function makeBitmapSource(
  track: InputVideoTrack,
  clipId: string,
): Promise<BitmapSource> {
  logTrace("bitmap-source-begin", { codec: track.codec, clipId })
  const sink = new VideoSampleSink(track)

  // Phase 1 collected RGBA into a JS array; phase 2 collects into a
  // single Uint8Array sized to total bytes and writes that to OPFS
  // in one shot at the end. This avoids per-frame OPFS writes (slow)
  // and avoids an unbounded JS array of small Uint8Arrays.
  const samples: Array<{ timestamp: number; bytes: Uint8Array }> = []
  let width = 0
  let height = 0
  let lastLog = performance.now()
  for await (const sample of sink.samples()) {
    const videoFrame = sample.toVideoFrame()
    try {
      width = videoFrame.displayWidth
      height = videoFrame.displayHeight
      const bytes = new Uint8Array(width * height * 4)
      await videoFrame.copyTo(bytes, { format: "RGBA" })
      const timestamp = sample.timestamp
      samples.push({ timestamp, bytes })
      const now = performance.now()
      if (now - lastLog > 250 || samples.length <= 3) {
        logTrace("bitmap-source-sample", { count: samples.length, ts: timestamp, clipId })
        lastLog = now
      }
    } finally {
      videoFrame.close()
      sample.close()
    }
  }

  // VideoSampleSink yields in decode order, which is NOT presentation
  // order for B-frame codecs. Sort by PTS so reader cursor walks in time.
  samples.sort((a, b) => a.timestamp - b.timestamp)

  const totalFrames = samples.length
  // Derive source fps from observed PTS span. MediaRecorder typically
  // produces ~30 fps but isn't guaranteed; the worker uses this to
  // pace its cursor. Falls back to 30 for very short clips where the
  // span is too small to be reliable.
  const sourceFps =
    samples.length >= 2 && samples[samples.length - 1].timestamp > samples[0].timestamp
      ? (samples.length - 1) /
        (samples[samples.length - 1].timestamp - samples[0].timestamp)
      : 30
  if (totalFrames === 0 || width === 0 || height === 0) {
    logTrace("bitmap-source-empty", { clipId })
    // No frames — return a degenerate source so callers don't crash.
    return {
      latestFrame: () => null,
      seek: () => {},
      reset: () => {},
      close: () => {},
    }
  }

  const frameSize = width * height * 4
  const totalBytes = totalFrames * frameSize
  const concatenated = new Uint8Array(totalBytes)
  for (let i = 0; i < totalFrames; i++) {
    concatenated.set(samples[i].bytes, i * frameSize)
  }
  await writeRgbaCache(clipId, concatenated)
  logTrace("bitmap-source-cached", { clipId, totalFrames, totalBytes })

  // Spawn the per-clip reader worker.
  const worker = new Worker(new URL("./bitmap-reader-worker.ts", import.meta.url), {
    type: "module",
  })

  let latest: BitmapFrame | null = null
  const { promise: ready, resolve: resolveReady } = Promise.withResolvers<void>()
  let doneResolve: (() => void) | null = null
  worker.onmessage = (
    event: MessageEvent<{
      type: string
      frames?: Array<{ bytes: ArrayBuffer }>
      reason?: string
    }>,
  ) => {
    if (event.data.type === "ready") {
      resolveReady()
      return
    }
    if (event.data.type === "done") {
      doneResolve?.()
      doneResolve = null
      return
    }
    if (event.data.type === "frames" && event.data.frames !== undefined) {
      const item = event.data.frames[0]
      if (item !== undefined) {
        latest = { bytes: new Uint8Array(item.bytes), width, height }
      }
      return
    }
    if (event.data.type === "dropped") {
      // Cache file became unreadable mid-session (OPFS eviction,
      // browser-data-cleared, etc.). Worker has stopped its read loop.
      // The cell paints nothing for the rest of the session; phase 3+
      // adds a re-decode-from-canonical recovery path.
      logTrace("bitmap-source-dropped", { clipId, reason: event.data.reason })
      latest = null
      return
    }
  }
  worker.postMessage({
    type: "init",
    fileName: `${clipId}.bin`,
    frameSize,
    totalFrames,
    sourceFps,
  })
  // Await the worker's ready message before returning. This guarantees
  // that any seek/reset issued by the caller immediately after
  // makeBitmapSource resolves will land AFTER init has set up the
  // worker's totalFrames / handle / cursor state.
  await ready

  return {
    latestFrame(): BitmapFrame | null {
      return latest
    },
    seek(tSeconds: number): void {
      worker.postMessage({ type: "seek", tSeconds })
    },
    reset(): void {
      // Synchronously clear latest so callers see null until the worker
      // posts the seeked frame. Matches phase 1's semantics.
      latest = null
      worker.postMessage({ type: "seek", tSeconds: 0 })
    },
    close(): void {
      // Synchronously clear `latest` so consumers immediately see "no
      // frame". The rest of the cleanup is async — we await the worker's
      // {type:'done'} confirmation (posted after it closes its
      // SyncAccessHandle) BEFORE terminating + deleting the cache file.
      // Without this sequencing, deleteRgbaCache would race the handle
      // release and silently leave an orphan file.
      latest = null
      ;(async () => {
        const done = new Promise<void>(resolve => {
          doneResolve = resolve
        })
        worker.postMessage({ type: "stop" })
        // Safety timeout in case the worker never responds (worker died
        // mid-init, etc.) — don't leak the cleanup forever.
        await Promise.race([done, wait(2000)])
        worker.terminate()
        await deleteRgbaCache(clipId).catch(() => {})
      })()
    },
  }
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
