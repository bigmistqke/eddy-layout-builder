# Device Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a throwaway on-device measurement harness that captures the four numbers (concurrent decoder ceiling, reset/reconfigure cost, single-decoder throughput, `texImage2D` upload cost) needed to choose and tune the video-playback-scaling architecture.

**Architecture:** A standalone page (`scripts/device-probe.html`) served by the existing vite dev server, opened in Chrome on a USB-connected Android phone via `scripts/android-debug.sh`, with results `console.log`'d as one JSON object and tailed back over CDP with `scripts/cdp-tail.ts`. The probe records a fresh VP8 clip on-device (same `getUserMedia` + `MediaRecorder` path as `src/media/capture.ts`), demuxes it to `EncodedVideoChunk`s with mediabunny, then runs four measurement functions. One pure helper — throughput-collapse detection — is unit-tested; the device-bound I/O is verified by the actual device run.

**Tech Stack:** TypeScript, WebCodecs (`VideoDecoder`), WebGL2, mediabunny (demux), vite (dev server), Playwright (unit test runner), adb + CDP (device harness).

---

## File Structure

- `scripts/device-probe.html` — page shell: a `<pre>` status log + module script entry.
- `scripts/device-probe/fallback-detect.ts` — pure function: detect throughput collapse in a latency-sample array. Unit-tested.
- `scripts/device-probe/input.ts` — record a fresh VP8 clip from the camera and demux it into `EncodedVideoChunk`s + `VideoDecoderConfig`.
- `scripts/device-probe/measure.ts` — the four measurement functions (M1–M4).
- `scripts/device-probe/main.ts` — orchestrator: records inputs, runs measurements, renders status to the page, logs the result JSON.
- `tests/device-probe-fallback.spec.ts` — unit test for `fallback-detect.ts`.

The probe is a **throwaway artifact** — it lives in `scripts/`, is never imported by `src/`, and is not shipped in the build.

---

## Task 1: Throughput-collapse detector (pure, TDD)

The only piece of pure logic in the probe: given an array of per-decode latency samples (ms), decide whether decode throughput has collapsed (the signature of Android's silent hardware→software decoder fallback — there is no API for it). Full red-green TDD.

**Files:**
- Create: `scripts/device-probe/fallback-detect.ts`
- Test: `tests/device-probe-fallback.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/device-probe-fallback.spec.ts`:

```ts
import { test, expect } from "@playwright/test"
import {
  detectThroughputCollapse,
  DEFAULT_COLLAPSE_OPTIONS,
} from "../scripts/device-probe/fallback-detect"

test("returns null when there are too few samples", () => {
  expect(detectThroughputCollapse([1, 1, 1])).toBe(null)
})

test("returns null when latency stays flat and healthy", () => {
  const samples = Array.from({ length: 40 }, () => 5)
  expect(detectThroughputCollapse(samples)).toBe(null)
})

test("returns null for a single spike that is not sustained", () => {
  const samples = Array.from({ length: 40 }, () => 5)
  samples[20] = 500
  expect(detectThroughputCollapse(samples)).toBe(null)
})

test("returns the 1-based start index of a sustained collapse", () => {
  // 10-sample baseline at 5ms, then a sustained jump to 100ms.
  const samples = [
    ...Array.from({ length: 10 }, () => 5),
    ...Array.from({ length: 10 }, () => 100),
  ]
  // factor 4 → threshold 20ms; confirmWindow 5 → first 5-long all-over-threshold
  // window starts at sample index 11 (1-based).
  expect(detectThroughputCollapse(samples)).toBe(11)
})

test("DEFAULT_COLLAPSE_OPTIONS has the documented shape", () => {
  expect(DEFAULT_COLLAPSE_OPTIONS).toEqual({
    baselineWindow: 10,
    confirmWindow: 5,
    factor: 4,
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec playwright test tests/device-probe-fallback.spec.ts`
Expected: FAIL — cannot resolve `../scripts/device-probe/fallback-detect`.

- [ ] **Step 3: Write minimal implementation**

Create `scripts/device-probe/fallback-detect.ts`:

```ts
/**
 * Detect the silent hardware→software decoder fallback (or saturation)
 * that Android Chrome performs without raising an error. The signature
 * is a sustained collapse in decode throughput: per-decode latency for
 * the most recent window rises far above the baseline established by
 * the first window.
 *
 * Pure function over latency samples (milliseconds, in decode-completion
 * order). Returns the 1-based sample index where a sustained collapse
 * first begins, or null if throughput stayed healthy.
 */
export interface CollapseOptions {
  /** Leading samples used to establish the healthy baseline. */
  baselineWindow: number
  /** Trailing samples that must ALL exceed the threshold to confirm. */
  confirmWindow: number
  /** Collapse = every sample in a confirm-window > factor × baseline median. */
  factor: number
}

export const DEFAULT_COLLAPSE_OPTIONS: CollapseOptions = {
  baselineWindow: 10,
  confirmWindow: 5,
  factor: 4,
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2
  }
  return sorted[mid]
}

export function detectThroughputCollapse(
  samples: number[],
  options: CollapseOptions = DEFAULT_COLLAPSE_OPTIONS,
): number | null {
  const { baselineWindow, confirmWindow, factor } = options
  if (samples.length < baselineWindow + confirmWindow) {
    return null
  }
  const threshold = median(samples.slice(0, baselineWindow)) * factor
  for (let end = baselineWindow + confirmWindow; end <= samples.length; end++) {
    const window = samples.slice(end - confirmWindow, end)
    if (window.every(sample => sample > threshold)) {
      return end - confirmWindow + 1
    }
  }
  return null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec playwright test tests/device-probe-fallback.spec.ts`
Expected: PASS — 5 passed.

- [ ] **Step 5: Commit**

```bash
git add scripts/device-probe/fallback-detect.ts tests/device-probe-fallback.spec.ts
git commit -m "feat: throughput-collapse detector for device probe"
```

---

## Task 2: Probe input — record + demux

Record a fresh VP8 clip from the device camera at a requested resolution and demux it into `EncodedVideoChunk`s plus the `VideoDecoderConfig`. Device-bound I/O — verified by `pnpm typecheck` here and exercised for real in Task 5.

**Files:**
- Create: `scripts/device-probe/input.ts`

- [ ] **Step 1: Write the module**

Create `scripts/device-probe/input.ts`:

```ts
import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from "mediabunny"
import { wait } from "../../src/utils"

/** Everything one measurement run needs from a single recorded clip. */
export interface ProbeInput {
  /** Decoder config for the recorded track. */
  config: VideoDecoderConfig
  /** Encoded chunks in decode order — chunks[0] is a keyframe. */
  chunks: EncodedVideoChunk[]
  /** Actual coded dimensions of the recording. */
  width: number
  height: number
  /** Dimensions requested from getUserMedia (may differ from actual). */
  requestedWidth: number
  requestedHeight: number
}

/** ~5s at 30fps — enough delta chunks for a throughput measurement. */
const MAX_CHUNKS = 150

/**
 * Record a fresh VP8 clip from the device camera at the requested
 * resolution, then demux it into EncodedVideoChunks plus the decoder
 * config. Mirrors src/media/capture.ts's MediaRecorder path so the probe
 * measures exactly what this device produces.
 */
export async function recordProbeInput(
  requestedWidth: number,
  requestedHeight: number,
  seconds: number,
): Promise<ProbeInput> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: requestedWidth, height: requestedHeight },
    audio: true,
  })
  const mimeType = "video/webm;codecs=vp8,opus"
  if (!MediaRecorder.isTypeSupported(mimeType)) {
    throw new Error(`recordProbeInput: ${mimeType} unsupported`)
  }
  const recorder = new MediaRecorder(stream, { mimeType })
  const blobParts: Blob[] = []
  recorder.ondataavailable = event => {
    if (event.data.size > 0) {
      blobParts.push(event.data)
    }
  }
  const { promise: stopped, resolve: onStopped } = Promise.withResolvers<void>()
  recorder.onstop = () => {
    onStopped()
  }
  recorder.start()
  await wait(seconds * 1000)
  recorder.stop()
  await stopped
  for (const track of stream.getTracks()) {
    track.stop()
  }
  const blob = new Blob(blobParts, { type: mimeType })

  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
  const videoTrack = await input.getPrimaryVideoTrack()
  if (videoTrack === null) {
    throw new Error("recordProbeInput: recording has no video track")
  }
  const config = await videoTrack.getDecoderConfig()
  if (config === null) {
    throw new Error("recordProbeInput: track produced no decoder config")
  }
  const sink = new EncodedPacketSink(videoTrack)
  const chunks: EncodedVideoChunk[] = []
  for await (const packet of sink.packets()) {
    chunks.push(packet.toEncodedVideoChunk())
    if (chunks.length >= MAX_CHUNKS) {
      break
    }
  }
  if (chunks.length === 0 || chunks[0].type !== "key") {
    throw new Error("recordProbeInput: first packet is not a keyframe")
  }
  return {
    config,
    chunks,
    width: videoTrack.codedWidth,
    height: videoTrack.codedHeight,
    requestedWidth,
    requestedHeight,
  }
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm typecheck`
Expected: PASS — no errors. (If mediabunny's `getDecoderConfig` / `codedWidth` names differ from the above, fix to match the installed `mediabunny` types — these were taken from `node_modules/mediabunny`'s `InputVideoTrack` prototype: `getDecoderConfig`, `codedWidth`, `codedHeight`.)

- [ ] **Step 3: Commit**

```bash
git add scripts/device-probe/input.ts
git commit -m "feat: device-probe input recording + demux"
```

---

## Task 3: The four measurements

The measurement functions M1–M4. Device-bound — verified by `pnpm typecheck` here and run for real in Task 5.

**Files:**
- Create: `scripts/device-probe/measure.ts`

- [ ] **Step 1: Write the module**

Create `scripts/device-probe/measure.ts`:

```ts
import { detectThroughputCollapse } from "./fallback-detect"
import type { ProbeInput } from "./input"

/** M1 — how many VideoDecoders can be live at once before the wall. */
export interface DecoderCeilingResult {
  /** Decoders successfully configured + kept alive before the wall. */
  ceiling: number
  /** What ended the climb. */
  stoppedBy: "configure-threw" | "error-callback" | "throughput-collapse" | "max-reached"
}

/** M2 — cost of switching one decoder between streams. */
export interface ReconfigureResult {
  /** Mean ms for reset → configure → decode-first-keyframe → flush. */
  meanMs: number
  samplesMs: number[]
}

/** M3 — sustained decode throughput of a single decoder. */
export interface ThroughputResult {
  width: number
  height: number
  /** Sustained decoded frames per second. */
  framesPerSecond: number
  /** framesPerSecond / 30 — cells one decoder can serve in realtime. */
  realtimeCellBudget: number
}

/** M4 — cost of uploading one frame to a GL texture. */
export interface UploadResult {
  width: number
  height: number
  /** Mean ms per texImage2D + gl.finish(). */
  meanMs: number
}

/**
 * A VideoDecoder plus a one-shot latch its output callback fulfils. Each
 * `decodeAndWait` call arms the latch, issues the decode, and resolves
 * with the decode→output latency in ms. Output VideoFrames are closed
 * immediately (Android caps live VideoFrames at ~4).
 */
interface LatchedDecoder {
  decoder: VideoDecoder
  /** Decode one chunk; resolve with decode→output latency in ms. */
  decodeAndWait(chunk: EncodedVideoChunk): Promise<number>
  /** Total VideoFrames emitted since construction. */
  outputCount(): number
}

function createLatchedDecoder(
  config: VideoDecoderConfig,
  onError: (error: DOMException) => void,
): LatchedDecoder {
  let pending: { resolve(ms: number): void; start: number } | null = null
  let outputs = 0
  const decoder = new VideoDecoder({
    output(frame) {
      outputs++
      const latch = pending
      pending = null
      frame.close()
      if (latch !== null) {
        latch.resolve(performance.now() - latch.start)
      }
    },
    error: onError,
  })
  decoder.configure(config)
  return {
    decoder,
    decodeAndWait(chunk) {
      const { promise, resolve } = Promise.withResolvers<number>()
      pending = { resolve, start: performance.now() }
      decoder.decode(chunk)
      return promise
    },
    outputCount() {
      return outputs
    },
  }
}

/**
 * M1 — concurrent decoder ceiling. Allocate decoders one at a time, each
 * kept alive and fed the keyframe, until configure() throws, an error
 * callback fires, or per-keyframe decode latency collapses (the silent
 * software-fallback signature). Closes every decoder before returning.
 */
export async function measureDecoderCeiling(
  input: ProbeInput,
  maxDecoders: number,
): Promise<DecoderCeilingResult> {
  const keyframe = input.chunks[0]
  const live: LatchedDecoder[] = []
  const latencies: number[] = []
  let errored = false
  try {
    for (let count = 1; count <= maxDecoders; count++) {
      let latched: LatchedDecoder
      try {
        latched = createLatchedDecoder(input.config, () => {
          errored = true
        })
      } catch {
        return { ceiling: live.length, stoppedBy: "configure-threw" }
      }
      live.push(latched)
      const latencyMs = await latched.decodeAndWait(keyframe)
      if (errored) {
        return { ceiling: live.length - 1, stoppedBy: "error-callback" }
      }
      latencies.push(latencyMs)
      if (detectThroughputCollapse(latencies) !== null) {
        return { ceiling: live.length - 1, stoppedBy: "throughput-collapse" }
      }
    }
    return { ceiling: live.length, stoppedBy: "max-reached" }
  } finally {
    for (const latched of live) {
      try {
        latched.decoder.close()
      } catch {
        // already closed / errored
      }
    }
  }
}

/**
 * M2 — reset/reconfigure cost. Time reset → configure → decode-keyframe →
 * flush on a single decoder, averaged over `iterations`.
 */
export async function measureReconfigureCost(
  input: ProbeInput,
  iterations: number,
): Promise<ReconfigureResult> {
  const keyframe = input.chunks[0]
  const latched = createLatchedDecoder(input.config, () => {})
  const samplesMs: number[] = []
  try {
    for (let i = 0; i < iterations; i++) {
      const start = performance.now()
      latched.decoder.reset()
      latched.decoder.configure(input.config)
      latched.decoder.decode(keyframe)
      await latched.decoder.flush()
      samplesMs.push(performance.now() - start)
    }
  } finally {
    try {
      latched.decoder.close()
    } catch {
      // already closed
    }
  }
  const meanMs = samplesMs.reduce((sum, value) => sum + value, 0) / samplesMs.length
  return { meanMs, samplesMs }
}

/**
 * M3 — single-decoder throughput. Feed every chunk to one decoder, flush,
 * and measure decoded frames per second from first decode() to flush
 * completion.
 */
export async function measureThroughput(input: ProbeInput): Promise<ThroughputResult> {
  const latched = createLatchedDecoder(input.config, () => {})
  let elapsedSeconds = 0
  try {
    const start = performance.now()
    for (const chunk of input.chunks) {
      latched.decoder.decode(chunk)
    }
    await latched.decoder.flush()
    elapsedSeconds = (performance.now() - start) / 1000
  } finally {
    try {
      latched.decoder.close()
    } catch {
      // already closed
    }
  }
  const framesPerSecond = elapsedSeconds > 0 ? latched.outputCount() / elapsedSeconds : 0
  return {
    width: input.width,
    height: input.height,
    framesPerSecond,
    realtimeCellBudget: framesPerSecond / 30,
  }
}

/** Decode one chunk to a VideoFrame, used as the M4 upload payload. */
function decodeOneFrame(input: ProbeInput): Promise<VideoFrame> {
  const { promise, resolve } = Promise.withResolvers<VideoFrame>()
  const decoder = new VideoDecoder({
    output(frame) {
      resolve(frame)
      decoder.close()
    },
    error() {
      // surfaced by the caller's try/catch via a never-resolved promise
    },
  })
  decoder.configure(input.config)
  decoder.decode(input.chunks[0])
  void decoder.flush()
  return promise
}

/**
 * M4 — texImage2D upload cost. Decode one frame, then upload it to a GL
 * texture `iterations` times with gl.finish() forcing GPU completion;
 * report the mean ms per upload.
 */
export async function measureUploadCost(
  input: ProbeInput,
  iterations: number,
): Promise<UploadResult> {
  const frame = await decodeOneFrame(input)
  const canvas = document.createElement("canvas")
  canvas.width = frame.displayWidth
  canvas.height = frame.displayHeight
  const gl = canvas.getContext("webgl2")
  if (gl === null) {
    frame.close()
    throw new Error("measureUploadCost: WebGL2 unavailable")
  }
  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  let totalMs = 0
  try {
    for (let i = 0; i < iterations; i++) {
      const start = performance.now()
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame)
      gl.finish()
      totalMs += performance.now() - start
    }
  } finally {
    gl.deleteTexture(texture)
    frame.close()
  }
  return {
    width: input.width,
    height: input.height,
    meanMs: totalMs / iterations,
  }
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm typecheck`
Expected: PASS — no errors.

- [ ] **Step 3: Commit**

```bash
git add scripts/device-probe/measure.ts
git commit -m "feat: device-probe measurement functions M1-M4"
```

---

## Task 4: Orchestrator + page shell

Wire the measurements together: record inputs at two resolutions, run M1–M4, render progress to the page, and log the result JSON with a recognizable prefix for `cdp-tail.ts`.

**Files:**
- Create: `scripts/device-probe/main.ts`
- Create: `scripts/device-probe.html`

- [ ] **Step 1: Write the orchestrator**

Create `scripts/device-probe/main.ts`:

```ts
import { recordProbeInput, type ProbeInput } from "./input"
import {
  measureDecoderCeiling,
  measureReconfigureCost,
  measureThroughput,
  measureUploadCost,
  type DecoderCeilingResult,
  type ReconfigureResult,
  type ThroughputResult,
  type UploadResult,
} from "./measure"

/** Recognizable prefix so cdp-tail.ts / a human can grep the result. */
const RESULT_PREFIX = "[device-probe-result]"

const MAX_DECODERS = 32
const RECONFIGURE_ITERATIONS = 30
const UPLOAD_ITERATIONS = 60
const RECORD_SECONDS = 6

interface ProbeResult {
  device: { userAgent: string; viewport: { width: number; height: number } }
  highRes: {
    input: { requested: string; actual: string }
    throughput: ThroughputResult
    upload: UploadResult
  }
  lowRes: {
    input: { requested: string; actual: string }
    throughput: ThroughputResult
    upload: UploadResult
  }
  decoderCeiling: DecoderCeilingResult
  reconfigure: ReconfigureResult
}

const statusElement = document.querySelector<HTMLPreElement>("#status")!

function status(line: string): void {
  statusElement.textContent += `${line}\n`
  // Also to the console so it shows up in the CDP tail.
  console.log(`[device-probe] ${line}`)
}

function dims(input: ProbeInput): { requested: string; actual: string } {
  return {
    requested: `${input.requestedWidth}x${input.requestedHeight}`,
    actual: `${input.width}x${input.height}`,
  }
}

async function run(): Promise<void> {
  status("recording high-res clip (320x240)...")
  const highInput = await recordProbeInput(320, 240, RECORD_SECONDS)
  status(`  got ${highInput.width}x${highInput.height}, ${highInput.chunks.length} chunks`)

  status("recording low-res clip (160x120)...")
  const lowInput = await recordProbeInput(160, 120, RECORD_SECONDS)
  status(`  got ${lowInput.width}x${lowInput.height}, ${lowInput.chunks.length} chunks`)

  status("M1: concurrent decoder ceiling...")
  const decoderCeiling = await measureDecoderCeiling(highInput, MAX_DECODERS)
  status(`  ceiling=${decoderCeiling.ceiling} (${decoderCeiling.stoppedBy})`)

  status("M2: reset/reconfigure cost...")
  const reconfigure = await measureReconfigureCost(highInput, RECONFIGURE_ITERATIONS)
  status(`  mean=${reconfigure.meanMs.toFixed(2)}ms`)

  status("M3: single-decoder throughput (high-res)...")
  const highThroughput = await measureThroughput(highInput)
  status(`  ${highThroughput.framesPerSecond.toFixed(1)} fps, budget=${highThroughput.realtimeCellBudget.toFixed(1)} cells`)

  status("M3: single-decoder throughput (low-res)...")
  const lowThroughput = await measureThroughput(lowInput)
  status(`  ${lowThroughput.framesPerSecond.toFixed(1)} fps, budget=${lowThroughput.realtimeCellBudget.toFixed(1)} cells`)

  status("M4: texImage2D upload cost (high-res)...")
  const highUpload = await measureUploadCost(highInput, UPLOAD_ITERATIONS)
  status(`  mean=${highUpload.meanMs.toFixed(3)}ms`)

  status("M4: texImage2D upload cost (low-res)...")
  const lowUpload = await measureUploadCost(lowInput, UPLOAD_ITERATIONS)
  status(`  mean=${lowUpload.meanMs.toFixed(3)}ms`)

  const result: ProbeResult = {
    device: {
      userAgent: navigator.userAgent,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    },
    highRes: {
      input: dims(highInput),
      throughput: highThroughput,
      upload: highUpload,
    },
    lowRes: {
      input: dims(lowInput),
      throughput: lowThroughput,
      upload: lowUpload,
    },
    decoderCeiling,
    reconfigure,
  }
  status("done.")
  console.log(`${RESULT_PREFIX} ${JSON.stringify(result)}`)
  statusElement.textContent += `\n${JSON.stringify(result, null, 2)}\n`
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  console.error("[device-probe] failed", error)
})
```

- [ ] **Step 2: Write the page shell**

Create `scripts/device-probe.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>device-probe</title>
    <style>
      body {
        margin: 0;
        padding: 12px;
        font: 13px/1.4 ui-monospace, monospace;
        background: #111;
        color: #eee;
      }
      pre {
        white-space: pre-wrap;
        word-break: break-word;
      }
    </style>
  </head>
  <body>
    <pre id="status">device-probe — grant camera + mic when prompted.
</pre>
    <script type="module" src="./device-probe/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 3: Verify it typechecks**

Run: `pnpm typecheck`
Expected: PASS — no errors.

- [ ] **Step 4: Verify the page loads in a desktop browser**

Run: `pnpm dev` (in a background terminal), then open `http://localhost:5173/scripts/device-probe.html` in desktop Chrome.
Expected: the page loads, prompts for camera/mic, and the status log advances through `M1`…`M4` to `done.` with a `[device-probe-result]` JSON line in the devtools console. (Desktop numbers are not the deliverable — this only confirms the probe runs end-to-end without throwing. If `getDecoderConfig`/`codedWidth` mediabunny names were wrong, this is where it surfaces — fix and re-run.)
Stop the dev server when done.

- [ ] **Step 5: Commit**

```bash
git add scripts/device-probe/main.ts scripts/device-probe.html
git commit -m "feat: device-probe orchestrator + page shell"
```

---

## Task 5: Run on the A15 and record results

Run the probe on the target device (Samsung Galaxy A15 / SM-A155F) and capture the JSON into the design doc. No code — this is the deliverable: real numbers.

**Files:**
- Modify: `docs/superpowers/specs/2026-05-14-video-playback-scaling-design.md` (append a "Probe results" section)

- [ ] **Step 1: Start the dev server**

Run: `pnpm dev` (background terminal — note the port, default 5173).

- [ ] **Step 2: Wire up the device**

Plug in the A15, open Chrome on it, then run: `scripts/android-debug.sh`
Expected: prints `reverse:` and `forward:` lines and a `--- tabs ---` list. If it reports no authorised device, accept the USB-debugging prompt on the phone and retry.

- [ ] **Step 3: Open the probe on the phone**

In Chrome on the A15, navigate to `http://localhost:5173/scripts/device-probe.html`.
Grant camera + mic when prompted. The on-screen log should start advancing.

- [ ] **Step 4: Tail the results over CDP**

Run: `URL_MATCH=device-probe scripts/cdp-tail.ts`
Expected: streams the `[device-probe]` progress lines, then one `[device-probe-result] {...}` JSON line. Copy that JSON.

- [ ] **Step 5: Record results in the design doc**

Append a `## Probe results` section to `docs/superpowers/specs/2026-05-14-video-playback-scaling-design.md` containing: the date, the device, the raw result JSON in a fenced block, and a one-paragraph reading of it against the Section 4 decision/tuning rule (what C, tile resolution, and handoff-pool size the numbers imply; and whether M1 ≥ ~16 + cheap M4 reopened the family question).

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-05-14-video-playback-scaling-design.md
git commit -m "docs: device-probe results on Galaxy A15"
```

---

## Self-Review

**Spec coverage:**
- Spec §1 "Device probe" — form, on-device recording, M1–M4, JSON output → Tasks 2 (input/recording), 3 (M1–M4), 4 (orchestrator/JSON), 5 (run). ✓
- Spec §1 software-fallback detection "by throughput collapse" → Task 1 (`fallback-detect`), consumed in Task 3's `measureDecoderCeiling`. ✓
- Spec §1 run harness (`android-debug.sh`, `cdp-tail.ts`) → Task 5. ✓
- Spec §4 decision/tuning rule → applied in Task 5 Step 5 (reading the numbers against the rule). ✓
- Spec §2/§3 (Architecture A/B) — explicitly out of scope for this plan; they become their own spec→plan cycle once probe data exists. ✓

**Placeholder scan:** No "TBD"/"TODO"/"handle edge cases"/thinking-aloud stubs. Every code step shows the complete final file content.

**Type consistency:** `ProbeInput` (defined Task 2) is consumed by every `measure.ts` function (Task 3) and `main.ts` (Task 4) with matching field names (`config`, `chunks`, `width`, `height`, `requestedWidth`, `requestedHeight`). `DecoderCeilingResult`/`ReconfigureResult`/`ThroughputResult`/`UploadResult` (defined Task 3) are imported by name in Task 4's `ProbeResult`. `detectThroughputCollapse` (Task 1) is called in Task 3 with a single `number[]` argument, matching its signature. ✓
