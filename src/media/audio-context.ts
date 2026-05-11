let context: AudioContext | null = null

/** Shared AudioContext for the session. 48kHz matches standard video
 *  recording sample rates, avoiding resampling on the playback path. */
export function audioContext(): AudioContext {
  if (context === null) {
    context = new AudioContext({ sampleRate: 48000 })
  }
  return context
}

/** Browsers suspend the AudioContext until the first user gesture.
 *  Idempotent — safe to await from every record/play handler. */
export async function resumeAudio(): Promise<void> {
  const audio = audioContext()
  if (audio.state === "suspended") {
    await audio.resume()
  }
}
