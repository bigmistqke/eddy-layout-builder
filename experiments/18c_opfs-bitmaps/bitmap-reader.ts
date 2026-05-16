// Long-lived reader: holds open SyncAccessHandles for each cell's
// OPFS file. Round-robins reading next frame per cell, posts raw
// RGBA bytes back (transferable). Throttled to ~30fps per cell so
// the renderer always has fresh-ish frames without flooding the
// main thread.

interface AddCellRequest {
  type: "add-cell"
  cellId: number
  filename: string
  frameWidth: number
  frameHeight: number
  frameCount: number
}
interface StopRequest {
  type: "stop"
}
type ReaderRequest = AddCellRequest | StopRequest

interface FrameMessage {
  type: "frame"
  cellId: number
  frameIndex: number
  width: number
  height: number
  bytes: ArrayBuffer
}

interface SyncAccessHandle {
  read(buffer: AllowSharedBufferSource, options?: { at?: number }): number
  close(): void
}

interface CellState {
  access: SyncAccessHandle
  frameWidth: number
  frameHeight: number
  frameCount: number
  cursor: number
}

const cells = new Map<number, CellState>()
let stopped = false
const targetFpsPerCell = 30

self.onmessage = async (event: MessageEvent<ReaderRequest>) => {
  if (event.data.type === "stop") {
    stopped = true
    for (const state of cells.values()) {
      state.access.close()
    }
    cells.clear()
    return
  }
  const { cellId, filename, frameWidth, frameHeight, frameCount } = event.data
  try {
    const root = await navigator.storage.getDirectory()
    const handle = await root.getFileHandle(filename)
    const access = await (handle as unknown as {
      createSyncAccessHandle(): Promise<SyncAccessHandle>
    }).createSyncAccessHandle()
    cells.set(cellId, { access, frameWidth, frameHeight, frameCount, cursor: 0 })
    console.log(`[reader] added cell ${cellId} from ${filename}, ${frameCount} frames`)
  } catch (error) {
    console.error(`[reader] add-cell ${cellId} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function loop(): Promise<void> {
  // One pass per ~33ms; per pass, read one frame for each active cell.
  while (!stopped) {
    const tickStart = performance.now()
    for (const [cellId, state] of cells) {
      const frameSize = state.frameWidth * state.frameHeight * 4
      const buf = new Uint8Array(frameSize)
      const offset = state.cursor * frameSize
      try {
        state.access.read(buf, { at: offset })
      } catch (error) {
        console.error(`[reader] cell ${cellId} read failed: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      state.cursor = (state.cursor + 1) % state.frameCount
      const message: FrameMessage = {
        type: "frame",
        cellId,
        frameIndex: state.cursor,
        width: state.frameWidth,
        height: state.frameHeight,
        bytes: buf.buffer,
      }
      ;(self as unknown as { postMessage(m: unknown, t: Transferable[]): void })
        .postMessage(message, [buf.buffer])
    }
    const elapsed = performance.now() - tickStart
    const targetIntervalMs = 1000 / targetFpsPerCell
    if (elapsed < targetIntervalMs) {
      await new Promise<void>(resolve => setTimeout(resolve, targetIntervalMs - elapsed))
    }
  }
}
loop()

export {}
