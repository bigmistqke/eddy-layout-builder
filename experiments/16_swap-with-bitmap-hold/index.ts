// swap-with-bitmap-hold — atlas swap pattern with ImageBitmap-hold
// instead of VideoFrame-hold. Validates two things across long idle:
//   - Held ImageBitmap stays paintable
//   - VideoDecoder internal state survives so the next delta decodes

import { wait } from "../../src/utils"
import { composite } from "../harness/composite"
import { recordProbeInput, type ProbeInput } from "../harness/input"
import { reportResult, status } from "../harness/report"

const params = {
  captureResolution: { width: 1280, height: 720 },
  atlasResolution: { width: 540, height: 983 },
  recordSeconds: 4,
  // Same as 12's bitmap cell size — what the renderer would actually
  // store for the swap.
  bitmapResolution: { width: 96, height: 174 },
  // 500ms (matches 14), 5s (typical between-takes gap), 30s (worst
  // case = one full song-length loop pass).
  holdMsList: [500, 5_000, 30_000],
}

interface HoldResult {
  holdMs: number
  bitmapPaintOk: boolean
  decoderStateOk: boolean
  postIdleDecodeMs: number
  postIdleFrameWidth: number
  postIdleFrameHeight: number
}

/** Decoder with an async queue: every `decode()` produces one frame
 *  that `nextFrame()` returns in FIFO order. Lets us decode chunk 0
 *  (warm-up), then decode chunk 1 (post-idle) without re-wiring the
 *  output callback — VideoDecoder.output is an internal slot, not a
 *  settable property at runtime. */
function makeQueuedDecoder(config: VideoDecoderConfig): {
  decoder: VideoDecoder
  nextFrame(): Promise<VideoFrame>
} {
  const queue: VideoFrame[] = []
  const waiters: ((frame: VideoFrame) => void)[] = []
  const errorWaiters: ((error: Error) => void)[] = []
  const decoder = new VideoDecoder({
    output(frame) {
      const waiter = waiters.shift()
      if (waiter) {
        waiter(frame)
      } else {
        queue.push(frame)
      }
    },
    error(error) {
      const waiter = errorWaiters.shift()
      if (waiter) {
        waiter(error)
      }
    },
  })
  decoder.configure(config)
  function nextFrame(): Promise<VideoFrame> {
    const queued = queue.shift()
    if (queued) {
      return Promise.resolve(queued)
    }
    return new Promise<VideoFrame>((resolve, reject) => {
      waiters.push(resolve)
      errorWaiters.push(reject)
    })
  }
  return { decoder, nextFrame }
}

/** WebGL2 painter — confirms the bitmap is still uploadable. Throws
 *  if texImage2D fails. Returns true if the upload succeeded. */
function tryPaintBitmap(bitmap: ImageBitmap): boolean {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const gl = canvas.getContext("webgl2")
  if (gl === null) {
    throw new Error("tryPaintBitmap: no webgl2 context")
  }
  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  try {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap)
    const error = gl.getError()
    gl.deleteTexture(texture)
    return error === gl.NO_ERROR
  } catch {
    gl.deleteTexture(texture)
    return false
  }
}

async function measureHold(atlas: ProbeInput, holdMs: number): Promise<HoldResult> {
  // Pre-warm: configure + decode chunk 0 → frame → bitmap → close frame.
  // Decoder stays open (state retained for chunks 1+).
  const { decoder, nextFrame } = makeQueuedDecoder(atlas.config)
  decoder.decode(atlas.chunks[0])
  const firstFrame = await nextFrame()
  const canvas = new OffscreenCanvas(params.bitmapResolution.width, params.bitmapResolution.height)
  const context = canvas.getContext("2d")
  if (context === null) {
    throw new Error("measureHold: no 2d context")
  }
  context.drawImage(firstFrame, 0, 0, params.bitmapResolution.width, params.bitmapResolution.height)
  firstFrame.close()
  const bitmap = canvas.transferToImageBitmap()

  status(`  holdMs=${holdMs} — sleeping...`)
  await wait(holdMs)

  let bitmapPaintOk = false
  try {
    bitmapPaintOk = tryPaintBitmap(bitmap)
  } catch {
    bitmapPaintOk = false
  }
  bitmap.close()

  let decoderStateOk = false
  let postIdleDecodeMs = 0
  let postIdleFrameWidth = 0
  let postIdleFrameHeight = 0
  const decodeStart = performance.now()
  try {
    decoder.decode(atlas.chunks[1])
    const frame = await nextFrame()
    postIdleDecodeMs = performance.now() - decodeStart
    postIdleFrameWidth = frame.codedWidth
    postIdleFrameHeight = frame.codedHeight
    decoderStateOk = postIdleFrameWidth > 0 && postIdleFrameHeight > 0
    frame.close()
  } catch {
    decoderStateOk = false
  }
  decoder.close()

  return {
    holdMs,
    bitmapPaintOk,
    decoderStateOk,
    postIdleDecodeMs,
    postIdleFrameWidth,
    postIdleFrameHeight,
  }
}

async function run(): Promise<void> {
  status(`recording source clip (${params.recordSeconds}s)...`)
  const source = await recordProbeInput(
    params.captureResolution.width,
    params.captureResolution.height,
    params.recordSeconds,
  )
  status(`  got ${source.width}x${source.height}, ${source.chunks.length} chunks`)

  status(`baking atlas (${params.atlasResolution.width}x${params.atlasResolution.height})...`)
  const { output: atlas, compositeMs } = await composite(
    source,
    4,
    4,
    params.atlasResolution.width,
    params.atlasResolution.height,
  )
  status(`  atlas ${atlas.width}x${atlas.height} built in ${compositeMs.toFixed(0)}ms, ${atlas.chunks.length} chunks`)

  const holds: HoldResult[] = []
  for (const holdMs of params.holdMsList) {
    status(`HOLD ${holdMs}ms — pre-warm + hold + post-idle paint & decode...`)
    const result = await measureHold(atlas, holdMs)
    status(
      `  hold ${holdMs}ms: bitmapPaintOk=${result.bitmapPaintOk}, decoderStateOk=${result.decoderStateOk}, ` +
        `postIdleDecode=${result.postIdleDecodeMs.toFixed(2)}ms, frame=${result.postIdleFrameWidth}x${result.postIdleFrameHeight}`,
    )
    holds.push(result)
  }

  status("done.")
  reportResult("swap-with-bitmap-hold", params, { holds })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("swap-with-bitmap-hold", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
