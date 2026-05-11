let context: AudioContext | null = null
let masterBus: GainNode | null = null
let mediaStreamDest: MediaStreamAudioDestinationNode | null = null
let routingElement: HTMLAudioElement | null = null
let routedToMediaStream = false

/** Shared AudioContext for the session. 48kHz matches standard video
 *  recording sample rates, avoiding resampling on the playback path. */
export function audioContext(): AudioContext {
  if (context === null) {
    context = new AudioContext({ sampleRate: 48000 })
    masterBus = context.createGain()
    masterBus.connect(context.destination)
  }
  return context
}

/** Master GainNode — all monitor playback (transport sources) should
 *  connect here, not directly to `AudioContext.destination`. Lets the
 *  router (below) swap the downstream destination during recording
 *  without touching every source. */
export function audioDestination(): GainNode {
  audioContext()
  return masterBus!
}

/** Re-route the master bus through a MediaStreamDestination + hidden
 *  HTMLAudioElement. Used during recording to dodge the Chrome bug
 *  where AudioContext.destination output interferes with concurrent
 *  `getUserMedia` capture (audible glitches on the recorded track).
 *  The user still hears the monitor via the <audio> element. */
export function useMediaStreamOutput(): void {
  if (routedToMediaStream) {
    return
  }
  const ctx = audioContext()
  masterBus!.disconnect()
  if (mediaStreamDest === null) {
    mediaStreamDest = ctx.createMediaStreamDestination()
  }
  masterBus!.connect(mediaStreamDest)
  if (routingElement === null) {
    routingElement = document.createElement("audio")
    routingElement.autoplay = true
  }
  routingElement.srcObject = mediaStreamDest.stream
  void routingElement.play().catch(() => {
    // First play() may need a user gesture context — the caller (a
    // record-button click handler) provides one, so this rarely fires.
  })
  routedToMediaStream = true
}

/** Reverse of `useMediaStreamOutput` — restore direct destination
 *  output. Safe to call when already direct (no-op). */
export function useDirectOutput(): void {
  if (!routedToMediaStream) {
    return
  }
  if (routingElement !== null) {
    routingElement.pause()
    routingElement.srcObject = null
  }
  masterBus!.disconnect()
  masterBus!.connect(audioContext().destination)
  routedToMediaStream = false
}

/** Browsers suspend the AudioContext until the first user gesture.
 *  Idempotent — safe to await from every record/play handler. */
export async function resumeAudio(): Promise<void> {
  const audio = audioContext()
  if (audio.state === "suspended") {
    await audio.resume()
  }
}
