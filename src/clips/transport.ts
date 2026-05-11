import { createSignal } from "solid-js"
import { audioContext, resumeAudio } from "../media/audio-context"
import type { Clip } from "./clip"

export type TransportState = "stopped" | "playing"

export interface Transport {
  state(): TransportState
  /** Seconds since the current play pass began. 0 when stopped. */
  position(): number
  /** Begin playback. Schedules audio at `audioContext.currentTime + 0.05`. */
  play(clips: Clip[]): Promise<void>
  stop(): void
}

const SCHEDULE_LEAD_SECONDS = 0.05

export function createTransport(): Transport {
  const [state, setState] = createSignal<TransportState>("stopped")
  const [startedAt, setStartedAt] = createSignal(0)
  let sources: AudioBufferSourceNode[] = []
  let stopTimer = 0

  async function play(clips: Clip[]) {
    if (state() === "playing") {
      stop()
    }
    if (clips.length === 0) {
      return
    }
    await resumeAudio()
    const audio = audioContext()
    const when = audio.currentTime + SCHEDULE_LEAD_SECONDS
    sources = []
    for (const clip of clips) {
      const source = audio.createBufferSource()
      source.buffer = clip.audio
      source.connect(audio.destination)
      source.start(when)
      sources.push(source)
    }
    setStartedAt(when)
    setState("playing")

    const longest = Math.max(...clips.map(clip => clip.duration))
    stopTimer = window.setTimeout(() => {
      stop()
    }, (longest + 0.1) * 1000)
  }

  function stop() {
    for (const source of sources) {
      try {
        source.stop()
      } catch {
        // not yet started
      }
    }
    sources = []
    window.clearTimeout(stopTimer)
    stopTimer = 0
    setState("stopped")
    setStartedAt(0)
  }

  function position() {
    if (state() !== "playing") {
      return 0
    }
    return audioContext().currentTime - startedAt()
  }

  return { state, position, play, stop }
}
