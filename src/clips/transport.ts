import { createSignal } from "solid-js"
import { audioContext, audioDestination, resumeAudio } from "../media/audio-context"
import type { Clip } from "./clip"

export type TransportState = "stopped" | "playing"

export interface Transport {
  state(): TransportState
  /** Seconds since the current play pass began. 0 when stopped. Resets
   *  to 0 at each loop boundary when `loopLength` is set. */
  position(): number
  /** Begin playback. If `loopLength` is provided, schedules a fresh
   *  pass every `loopLength` seconds. Otherwise plays once and stops. */
  play(clips: Clip[], loopLength?: number | null): Promise<void>
  stop(): void
  /** Mute the clip in the given cell (gain 0) while playback continues
   *  silently in lock with the song. Pass null to unmute. Used while a
   *  cell is in live-preview state so the recorded audio doesn't
   *  collide with the user's monitor; unmuting resumes audio in sync
   *  with the rest of the song. */
  setMutedCell(cellId: string | null): void
}

const SCHEDULE_LEAD_SECONDS = 0.05

export function createTransport(): Transport {
  const [state, setState] = createSignal<TransportState>("stopped")
  const [startedAt, setStartedAt] = createSignal(0)
  let sources: AudioBufferSourceNode[] = []
  /** Per-cell GainNode keyed by cellId. Lets `setMutedCell` flip a
   *  single cell's audio without re-scheduling sources, so the muted
   *  clip stays in sample-lock with the rest of the song. Cleared
   *  when sources are stopped (each schedule re-creates them). */
  let cellGains: Record<string, GainNode> = {}
  let mutedCell: string | null = null
  let loopTimer = 0

  function scheduleSources(clips: Clip[], when: number) {
    const audio = audioContext()
    const out = audioDestination()
    for (const clip of clips) {
      const source = audio.createBufferSource()
      const gain = audio.createGain()
      gain.gain.value = clip.cellId === mutedCell ? 0 : 1
      source.buffer = clip.audio
      source.connect(gain)
      gain.connect(out)
      source.start(when)
      sources.push(source)
      cellGains[clip.cellId] = gain
    }
  }

  function stopActiveSources() {
    for (const source of sources) {
      try {
        source.stop()
      } catch {
        // not yet started
      }
    }
    sources = []
    cellGains = {}
  }

  function setMutedCell(cellId: string | null) {
    const previous = mutedCell
    mutedCell = cellId
    if (previous !== null) {
      const gain = cellGains[previous]
      if (gain !== undefined) {
        // Short ramp to avoid a click on the un-mute transition.
        const audio = audioContext()
        gain.gain.setTargetAtTime(1, audio.currentTime, 0.005)
      }
    }
    if (cellId !== null) {
      const gain = cellGains[cellId]
      if (gain !== undefined) {
        const audio = audioContext()
        gain.gain.setTargetAtTime(0, audio.currentTime, 0.005)
      }
    }
  }

  async function play(clips: Clip[], loopLength: number | null = null) {
    if (state() === "playing") {
      stop()
    }
    if (clips.length === 0) {
      return
    }
    await resumeAudio()
    const audio = audioContext()
    const firstWhen = audio.currentTime + SCHEDULE_LEAD_SECONDS
    scheduleSources(clips, firstWhen)
    setStartedAt(firstWhen)
    setState("playing")

    if (loopLength !== null) {
      const cycle = () => {
        if (state() !== "playing") {
          return
        }
        stopActiveSources()
        const audioNow = audioContext()
        const nextWhen = audioNow.currentTime + 0.01
        scheduleSources(clips, nextWhen)
        setStartedAt(nextWhen)
        loopTimer = window.setTimeout(cycle, loopLength * 1000)
      }
      loopTimer = window.setTimeout(cycle, loopLength * 1000)
    } else {
      const longest = Math.max(...clips.map(clip => clip.duration))
      loopTimer = window.setTimeout(() => {
        stop()
      }, (longest + 0.1) * 1000)
    }
  }

  function stop() {
    stopActiveSources()
    window.clearTimeout(loopTimer)
    loopTimer = 0
    setState("stopped")
    setStartedAt(0)
  }

  function position() {
    if (state() !== "playing") {
      return 0
    }
    // Audio is scheduled at startedAt = currentTime + SCHEDULE_LEAD_SECONDS,
    // so during the lead window currentTime - startedAt is negative.
    // Clamp to 0 so video frame lookups land on frame 0 instead of null.
    return Math.max(0, audioContext().currentTime - startedAt())
  }

  return { state, position, play, stop, setMutedCell }
}
