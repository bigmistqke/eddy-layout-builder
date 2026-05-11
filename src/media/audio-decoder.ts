import { AudioBufferSink, type InputAudioTrack } from "mediabunny"
import { audioContext } from "./audio-context"

/**
 * Decode an entire audio track into a single AudioBuffer. Mediabunny's
 * AudioBufferSink yields per-packet `AudioBuffer` chunks in presentation
 * order — concatenate them into one buffer matching the AudioContext's
 * sample rate.
 *
 * For MVP: clips are short (seconds → ~minutes), fits in memory easily.
 */
export async function decodeToAudioBuffer(track: InputAudioTrack): Promise<AudioBuffer> {
  const sink = new AudioBufferSink(track)
  const chunks: AudioBuffer[] = []
  for await (const wrapped of sink.buffers()) {
    chunks.push(wrapped.buffer)
  }
  if (chunks.length === 0) {
    throw new Error("decodeToAudioBuffer: track produced no audio buffers")
  }

  const sampleRate = chunks[0].sampleRate
  const numberOfChannels = chunks[0].numberOfChannels
  const totalFrames = chunks.reduce((sum, buffer) => sum + buffer.length, 0)

  const output = audioContext().createBuffer(numberOfChannels, totalFrames, sampleRate)
  let writeOffset = 0
  for (const chunk of chunks) {
    for (let channel = 0; channel < numberOfChannels; channel++) {
      output.copyToChannel(chunk.getChannelData(channel), channel, writeOffset)
    }
    writeOffset += chunk.length
  }
  return output
}
