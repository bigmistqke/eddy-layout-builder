export interface CaptureHandle {
  /** Underlying MediaStream — used by preview to attach to an HTMLVideoElement. */
  stream: MediaStream
  /** Stop recording and yield the encoded Blob. */
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

export async function startCapture(): Promise<CaptureHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
  const mimeType = pickMimeType()
  const recorder = new MediaRecorder(stream, { mimeType })
  const chunks: Blob[] = []
  recorder.ondataavailable = event => {
    if (event.data.size > 0) {
      chunks.push(event.data)
    }
  }
  recorder.start()

  function teardownStream() {
    for (const track of stream.getTracks()) {
      track.stop()
    }
  }

  function stop(): Promise<Blob> {
    const { promise, resolve } = Promise.withResolvers<Blob>()
    recorder.onstop = () => {
      teardownStream()
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
    teardownStream()
  }

  return { stream, stop, cancel }
}
