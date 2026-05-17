import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
} from "mediabunny"
import type { Clip } from "../clips/clip"
import type { Node } from "../types"
import { layoutFrames } from "../viewport"
import { createRenderer, type TextureSource } from "../webgl/renderer"

const FPS = 30
const VIDEO_BITRATE = 4_000_000
const AUDIO_BITRATE = 128_000
const VIEWPORT_IDENTITY = { x: 0, y: 0, scale: 1 }

export interface ExportOptions {
  width: number
  height: number
  /** Called with a value in [0, 1] after each rendered frame. */
  onProgress?(fraction: number): void
}

/**
 * Render the song to an MP4 blob off-clock. Encoders consume samples
 * as fast as we feed them; we await `canvasSource.add` and
 * `audioSource.add` for backpressure.
 */
export async function exportSong(
  clips: Clip[],
  layout: Node,
  options: ExportOptions,
): Promise<Blob> {
  if (clips.length === 0) {
    throw new Error("exportSong: no clips")
  }
  const { width, height, onProgress } = options
  const duration = Math.max(...clips.map(clip => clip.duration))

  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const renderer = createRenderer(canvas)
  renderer.resize(width, height)

  const { leaves } = layoutFrames(layout, { width, height }, null)

  const output = new Output({
    format: new Mp4OutputFormat(),
    target: new BufferTarget(),
  })
  const videoSource = new CanvasSource(canvas, {
    codec: "avc",
    bitrate: VIDEO_BITRATE,
  })
  output.addVideoTrack(videoSource)

  const mixedAudio = await mixAudio(clips, duration)
  const audioSource = new AudioBufferSource({ codec: "aac", bitrate: AUDIO_BITRATE })
  output.addAudioTrack(audioSource)

  await output.start()

  await audioSource.add(mixedAudio)
  audioSource.close()

  const frameDuration = 1 / FPS
  const totalFrames = Math.max(1, Math.ceil(duration * FPS))
  for (let i = 0; i < totalFrames; i++) {
    const t = i * frameDuration
    const frames = new Map<string, TextureSource>()
    for (const clip of clips) {
      clip.video.seek(t)
      const frame = clip.video.latestFrame()
      if (frame !== null) {
        frames.set(clip.cellId, frame)
      }
    }
    renderer.render(VIEWPORT_IDENTITY, leaves, frames.size > 0 ? frames : undefined)
    await videoSource.add(t, frameDuration)
    onProgress?.((i + 1) / totalFrames)
  }
  videoSource.close()

  await output.finalize()
  renderer.dispose()

  const target = output.target as BufferTarget
  if (target.buffer === null) {
    throw new Error("exportSong: BufferTarget produced no buffer")
  }
  return new Blob([target.buffer], { type: "video/mp4" })
}

async function mixAudio(clips: Clip[], duration: number): Promise<AudioBuffer> {
  const sampleRate = clips[0].audio.sampleRate
  const channels = Math.max(...clips.map(clip => clip.audio.numberOfChannels))
  const totalSamples = Math.max(1, Math.ceil(duration * sampleRate))
  const offline = new OfflineAudioContext(channels, totalSamples, sampleRate)
  for (const clip of clips) {
    const source = offline.createBufferSource()
    source.buffer = clip.audio
    source.connect(offline.destination)
    source.start(0)
  }
  return offline.startRendering()
}
