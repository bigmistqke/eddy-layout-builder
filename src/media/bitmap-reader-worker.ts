/// <reference lib="webworker" />
declare const self: DedicatedWorkerGlobalScope

// Per-clip RGBA bitmap reader. Owns a SyncAccessHandle on
// /rgba/<cellId>.bin, advances a cursor at source-fps, posts the
// current frame to main as a transferable Uint8Array.
//
// Protocol:
//   main → worker: {type:'init', fileName, frameSize, totalFrames, sourceFps}
//   main → worker: {type:'seek', tSeconds}
//   main → worker: {type:'stop'}
//   worker → main: {type:'ready'}
//   worker → main: {type:'frames', frames:[{bytes}]}  (bytes transferable)
//   worker → main: {type:'dropped', reason}           (read failed — file gone, handle invalidated)
//   worker → main: {type:'done'}                      (after stop)
//
// Defensive reads: a SyncAccessHandle holds an exclusive lock, so the
// cache file can't be deleted while the worker holds it. But under
// OPFS eviction (extreme disk pressure) or browser-data-clearing the
// handle CAN be invalidated mid-session; the next read throws. We
// catch, post {type:'dropped'} so the BitmapSource sets latest=null,
// and exit the loop cleanly. Recovery (re-decode from canonical) is
// phase 3+.

import { wait } from "../utils"

interface InitMessage {
  type: "init"
  fileName: string
  frameSize: number
  totalFrames: number
  sourceFps: number
}

interface SeekMessage {
  type: "seek"
  tSeconds: number
}

interface StopMessage {
  type: "stop"
}

type Request = InitMessage | SeekMessage | StopMessage

interface ReadyMessage {
  type: "ready"
}

interface FrameItem {
  bytes: ArrayBuffer
}

interface FramesMessage {
  type: "frames"
  frames: FrameItem[]
}

interface DroppedMessage {
  type: "dropped"
  reason: string
}

interface DoneMessage {
  type: "done"
}

const RGBA_DIR_NAME = "rgba"

let running = false
let initialized = false
let stopRequested = false
let handle: FileSystemSyncAccessHandle | null = null
let frameSize = 0
let totalFrames = 0
let intervalMs = 0
let sourceFps = 0
let cursor = 0
let lastAdvanceMs = 0

function readCurrentFrame(): ArrayBuffer | null {
  if (handle === null) {
    return null
  }
  const buf = new ArrayBuffer(frameSize)
  handle.read(new Uint8Array(buf), { at: cursor * frameSize })
  return buf
}

function postDropped(reason: string): void {
  const msg: DroppedMessage = { type: "dropped", reason }
  self.postMessage(msg)
}

self.onmessage = async (event: MessageEvent<Request>) => {
  if (event.data.type === "stop") {
    stopRequested = true
    running = false
    return
  }
  if (event.data.type === "seek") {
    if (!initialized || totalFrames === 0) {
      return
    }
    const targetIndex = Math.max(
      0,
      Math.min(totalFrames - 1, Math.floor(event.data.tSeconds * sourceFps)),
    )
    cursor = targetIndex
    lastAdvanceMs = performance.now()
    // Send the seeked frame immediately so main has fresh bytes.
    let bytes: ArrayBuffer | null = null
    try {
      bytes = readCurrentFrame()
    } catch (error) {
      running = false
      postDropped(error instanceof Error ? error.message : String(error))
      return
    }
    if (bytes !== null) {
      const msg: FramesMessage = { type: "frames", frames: [{ bytes }] }
      self.postMessage(msg, [bytes])
    }
    return
  }
  if (event.data.type !== "init") {
    return
  }
  const init = event.data
  frameSize = init.frameSize
  totalFrames = init.totalFrames
  sourceFps = init.sourceFps
  intervalMs = 1000 / init.sourceFps
  cursor = 0
  lastAdvanceMs = 0

  const root = await navigator.storage.getDirectory()
  const dir = await root.getDirectoryHandle(RGBA_DIR_NAME, { create: false })
  const fileHandle = await dir.getFileHandle(init.fileName, { create: false })
  handle = await fileHandle.createSyncAccessHandle()
  initialized = true

  if (stopRequested) {
    // Stop arrived mid-init; close immediately and exit without
    // entering the read loop.
    try {
      handle.close()
    } catch {}
    handle = null
    const done: DoneMessage = { type: "done" }
    self.postMessage(done)
    return
  }

  // Post first frame immediately so main has something to paint.
  let firstBytes: ArrayBuffer | null = null
  try {
    firstBytes = readCurrentFrame()
  } catch (error) {
    postDropped(error instanceof Error ? error.message : String(error))
    return
  }
  if (firstBytes !== null) {
    const msg: FramesMessage = { type: "frames", frames: [{ bytes: firstBytes }] }
    self.postMessage(msg, [firstBytes])
  }

  const ready: ReadyMessage = { type: "ready" }
  self.postMessage(ready)

  running = true
  while (running) {
    const now = performance.now()
    if (now - lastAdvanceMs >= intervalMs) {
      cursor = (cursor + 1) % totalFrames
      lastAdvanceMs = now
      let bytes: ArrayBuffer | null = null
      try {
        bytes = readCurrentFrame()
      } catch (error) {
        postDropped(error instanceof Error ? error.message : String(error))
        running = false
        break
      }
      if (bytes !== null) {
        const msg: FramesMessage = { type: "frames", frames: [{ bytes }] }
        self.postMessage(msg, [bytes])
      }
    }
    await wait(2)
  }

  try {
    handle.close()
  } catch {}
  handle = null
  const done: DoneMessage = { type: "done" }
  self.postMessage(done)
}
