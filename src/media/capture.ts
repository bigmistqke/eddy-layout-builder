import { logTrace } from "../utils"

export interface CaptureHandle {
  /** Stop recording and yield the encoded Blob. The underlying
   *  MediaStream is NOT stopped — the caller owns it. */
  stop(): Promise<Blob>
  /** Stop without keeping the blob (e.g. user cancelled). */
  cancel(): void
}

// VP8 first: MediaRecorder on Android Chrome can encode VP9, but the
// platform's WebCodecs VideoDecoder often can't decode VP9 back —
// `VideoSampleSink.samples()` hangs with no error. VP8 has broader
// WebCodecs decode support across mobile.
const PREFERRED_MIME_TYPES = [
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp9,opus",
  "video/webm",
]

function pickMimeType(): string {
  const supported = PREFERRED_MIME_TYPES.map(m => ({ m, ok: MediaRecorder.isTypeSupported(m) }))
  logTrace("capture-mime-probe", { supported })
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
  const tracks = stream.getTracks().map(t => ({
    kind: t.kind,
    label: t.label,
    enabled: t.enabled,
    readyState: t.readyState,
  }))
  logTrace("capture-start", { mimeType, tracks })
  const recorder = new MediaRecorder(stream, { mimeType })
  const chunks: Blob[] = []
  recorder.ondataavailable = event => {
    if (event.data.size > 0) {
      chunks.push(event.data)
    }
  }
  recorder.onerror = event => {
    logTrace("capture-recorder-error", { error: String((event as ErrorEvent).error ?? event) })
  }
  recorder.start()

  function stop(): Promise<Blob> {
    const { promise, resolve } = Promise.withResolvers<Blob>()
    logTrace("capture-stop-begin", { state: recorder.state, chunkCount: chunks.length })
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType })
      logTrace("capture-stop-done", { chunkCount: chunks.length, blobSize: blob.size, blobType: blob.type })
      resolve(blob)
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
