export interface CaptureHandle {
  /** Stop recording and yield the encoded Blob. The underlying
   *  MediaStream is NOT stopped — the caller owns it. */
  stop(): Promise<Blob>
  /** Stop without keeping the blob (e.g. user cancelled). */
  cancel(): void
}

const PREFERRED_MIME_TYPES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
]

function pickMimeType(): string {
  for (const candidate of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate
    }
  }
  throw new Error("capture: no supported MediaRecorder mime type")
}

/**
 * Start recording from an existing MediaStream. The stream is borrowed —
 * the caller is responsible for its lifecycle. Caller calls `stop()` to
 * get the encoded blob; the stream stays live.
 */
export function startCapture(stream: MediaStream): CaptureHandle {
  const mimeType = pickMimeType()
  const recorder = new MediaRecorder(stream, { mimeType })
  const chunks: Blob[] = []
  recorder.ondataavailable = event => {
    if (event.data.size > 0) {
      chunks.push(event.data)
    }
  }
  recorder.start()

  function stop(): Promise<Blob> {
    const { promise, resolve } = Promise.withResolvers<Blob>()
    recorder.onstop = () => {
      resolve(new Blob(chunks, { type: mimeType }))
    }
    recorder.stop()
    return promise
  }

  function cancel(): void {
    recorder.onstop = null
    try {
      recorder.stop()
    } catch {
      // already stopped
    }
  }

  return { stop, cancel }
}
