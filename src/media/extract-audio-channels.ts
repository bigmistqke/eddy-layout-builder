/**
 * Extract Audio Channels
 *
 * Extracts channel data from AudioData objects, handling both
 * planar and interleaved formats (f32-planar, f32, s16).
 */

/**
 * Extract per-channel Float32Array samples from an AudioData object.
 * Handles planar formats (f32-planar) and interleaved formats (f32, s16).
 * Does NOT close the AudioData - caller is responsible for cleanup.
 */
export function extractAudioChannelsFromAudioData(audioData: AudioData): Float32Array[] {
  const numberOfChannels = audioData.numberOfChannels
  const numberOfFrames = audioData.numberOfFrames
  const format = audioData.format

  const channels: Float32Array[] = []

  if (format?.endsWith('-planar')) {
    // Planar format: each channel is a separate plane
    for (let channel = 0; channel < numberOfChannels; channel++) {
      const channelData = new Float32Array(numberOfFrames)
      audioData.copyTo(channelData, { planeIndex: channel })
      channels.push(channelData)
    }
  } else if (format === 'f32') {
    // Interleaved f32: all channels in plane 0
    const byteSize = audioData.allocationSize({ planeIndex: 0 })
    const tempBuffer = new ArrayBuffer(byteSize)
    audioData.copyTo(tempBuffer, { planeIndex: 0 })
    const interleaved = new Float32Array(tempBuffer)
    for (let channel = 0; channel < numberOfChannels; channel++) {
      const channelData = new Float32Array(numberOfFrames)
      for (let i = 0; i < numberOfFrames; i++) {
        channelData[i] = interleaved[i * numberOfChannels + channel]!
      }
      channels.push(channelData)
    }
  } else if (format === 's16') {
    // Interleaved s16: all channels in plane 0, convert to float
    const byteSize = audioData.allocationSize({ planeIndex: 0 })
    const tempBuffer = new ArrayBuffer(byteSize)
    audioData.copyTo(tempBuffer, { planeIndex: 0 })
    const interleaved = new Int16Array(tempBuffer)
    for (let channel = 0; channel < numberOfChannels; channel++) {
      const channelData = new Float32Array(numberOfFrames)
      for (let i = 0; i < numberOfFrames; i++) {
        channelData[i] = interleaved[i * numberOfChannels + channel]! / 32768
      }
      channels.push(channelData)
    }
  } else {
    // Fallback: try to copy as planar (might fail for some formats)
    for (let channel = 0; channel < numberOfChannels; channel++) {
      const channelData = new Float32Array(numberOfFrames)
      try {
        audioData.copyTo(channelData, { planeIndex: channel, format: 'f32-planar' })
      } catch {
        channelData.fill(0)
      }
      channels.push(channelData)
    }
  }

  return channels
}
