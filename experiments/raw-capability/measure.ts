import { detectThroughputCollapse } from "../harness/fallback-detect"
import type { ProbeInput } from "../harness/input"

/** M1 — how many VideoDecoders can be live at once before the wall. */
export interface DecoderCeilingResult {
  /** Decoders successfully configured + kept alive before the wall. */
  ceiling: number
  /** What ended the climb. */
  stoppedBy: "configure-threw" | "error-callback" | "throughput-collapse" | "max-reached"
}

/** M2 — cost of switching one decoder between streams. */
export interface ReconfigureResult {
  /** Mean ms for reset → configure → decode-first-keyframe → flush. */
  meanMs: number
  samplesMs: number[]
}

/** M3 — sustained decode throughput of a single decoder. */
export interface ThroughputResult {
  width: number
  height: number
  /** Sustained decoded frames per second. */
  framesPerSecond: number
  /** framesPerSecond / 30 — cells one decoder can serve in realtime. */
  realtimeCellBudget: number
}

/** M4 — cost of uploading one frame to a GL texture. */
export interface UploadResult {
  width: number
  height: number
  /** Mean ms per texImage2D + gl.finish(). */
  meanMs: number
}

/**
 * A VideoDecoder plus a one-shot latch its output callback fulfils. Each
 * `decodeAndWait` call arms the latch, issues the decode, and resolves
 * with the decode→output latency in ms. Output VideoFrames are closed
 * immediately (Android caps live VideoFrames at ~4).
 */
interface LatchedDecoder {
  decoder: VideoDecoder
  /** Decode one chunk; resolve with decode→output latency in ms. */
  decodeAndWait(chunk: EncodedVideoChunk): Promise<number>
  /** Total VideoFrames emitted since construction. */
  outputCount(): number
}

function createLatchedDecoder(
  config: VideoDecoderConfig,
  onError: (error: DOMException) => void,
): LatchedDecoder {
  let pending: { resolve(ms: number): void; start: number } | null = null
  let outputs = 0
  const decoder = new VideoDecoder({
    output(frame) {
      outputs++
      const latch = pending
      pending = null
      frame.close()
      if (latch !== null) {
        latch.resolve(performance.now() - latch.start)
      }
    },
    error: onError,
  })
  decoder.configure(config)
  return {
    decoder,
    decodeAndWait(chunk) {
      const { promise, resolve } = Promise.withResolvers<number>()
      pending = { resolve, start: performance.now() }
      decoder.decode(chunk)
      return promise
    },
    outputCount() {
      return outputs
    },
  }
}

/**
 * M1 — concurrent decoder ceiling. Allocate decoders one at a time, each
 * kept alive and fed the keyframe, until configure() throws, an error
 * callback fires, or per-keyframe decode latency collapses (the silent
 * software-fallback signature). Closes every decoder before returning.
 */
export async function measureDecoderCeiling(
  input: ProbeInput,
  maxDecoders: number,
): Promise<DecoderCeilingResult> {
  const keyframe = input.chunks[0]
  const live: LatchedDecoder[] = []
  const latencies: number[] = []
  let errored = false
  try {
    for (let count = 1; count <= maxDecoders; count++) {
      let latched: LatchedDecoder
      try {
        latched = createLatchedDecoder(input.config, () => {
          errored = true
        })
      } catch {
        return { ceiling: live.length, stoppedBy: "configure-threw" }
      }
      live.push(latched)
      const latencyMs = await latched.decodeAndWait(keyframe)
      if (errored) {
        return { ceiling: live.length - 1, stoppedBy: "error-callback" }
      }
      latencies.push(latencyMs)
      if (detectThroughputCollapse(latencies) !== null) {
        return { ceiling: live.length - 1, stoppedBy: "throughput-collapse" }
      }
    }
    return { ceiling: live.length, stoppedBy: "max-reached" }
  } finally {
    for (const latched of live) {
      try {
        latched.decoder.close()
      } catch {
        // already closed / errored
      }
    }
  }
}

/**
 * M2 — reset/reconfigure cost. Time reset → configure → decode-keyframe →
 * flush on a single decoder, averaged over `iterations`.
 */
export async function measureReconfigureCost(
  input: ProbeInput,
  iterations: number,
): Promise<ReconfigureResult> {
  const keyframe = input.chunks[0]
  const latched = createLatchedDecoder(input.config, () => {})
  const samplesMs: number[] = []
  try {
    for (let i = 0; i < iterations; i++) {
      const start = performance.now()
      latched.decoder.reset()
      latched.decoder.configure(input.config)
      latched.decoder.decode(keyframe)
      await latched.decoder.flush()
      samplesMs.push(performance.now() - start)
    }
  } finally {
    try {
      latched.decoder.close()
    } catch {
      // already closed
    }
  }
  const meanMs = samplesMs.reduce((sum, value) => sum + value, 0) / samplesMs.length
  return { meanMs, samplesMs }
}

/**
 * M3 — single-decoder throughput. Feed every chunk to one decoder, flush,
 * and measure decoded frames per second from first decode() to flush
 * completion.
 */
export async function measureThroughput(input: ProbeInput): Promise<ThroughputResult> {
  const latched = createLatchedDecoder(input.config, () => {})
  let elapsedSeconds = 0
  try {
    const start = performance.now()
    for (const chunk of input.chunks) {
      latched.decoder.decode(chunk)
    }
    await latched.decoder.flush()
    elapsedSeconds = (performance.now() - start) / 1000
  } finally {
    try {
      latched.decoder.close()
    } catch {
      // already closed
    }
  }
  const framesPerSecond = elapsedSeconds > 0 ? latched.outputCount() / elapsedSeconds : 0
  return {
    width: input.width,
    height: input.height,
    framesPerSecond,
    realtimeCellBudget: framesPerSecond / 30,
  }
}

/** Decode one chunk to a VideoFrame, used as the M4 upload payload. */
function decodeOneFrame(input: ProbeInput): Promise<VideoFrame> {
  const { promise, resolve } = Promise.withResolvers<VideoFrame>()
  const decoder = new VideoDecoder({
    output(frame) {
      resolve(frame)
      decoder.close()
    },
    error() {
      // surfaced by the caller's try/catch via a never-resolved promise
    },
  })
  decoder.configure(input.config)
  decoder.decode(input.chunks[0])
  void decoder.flush()
  return promise
}

/**
 * M4 — texImage2D upload cost. Decode one frame, then upload it to a GL
 * texture `iterations` times with gl.finish() forcing GPU completion;
 * report the mean ms per upload.
 */
export async function measureUploadCost(
  input: ProbeInput,
  iterations: number,
): Promise<UploadResult> {
  const frame = await decodeOneFrame(input)
  const canvas = document.createElement("canvas")
  canvas.width = frame.displayWidth
  canvas.height = frame.displayHeight
  const gl = canvas.getContext("webgl2")
  if (gl === null) {
    frame.close()
    throw new Error("measureUploadCost: WebGL2 unavailable")
  }
  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  let totalMs = 0
  try {
    for (let i = 0; i < iterations; i++) {
      const start = performance.now()
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame)
      gl.finish()
      totalMs += performance.now() - start
    }
  } finally {
    gl.deleteTexture(texture)
    frame.close()
  }
  return {
    width: input.width,
    height: input.height,
    meanMs: totalMs / iterations,
  }
}
