// software-decoder — compare hardwareAcceleration prefer-hardware vs
// prefer-software at N=1, 4, 8. Tests whether software decoding
// sidesteps the GPU bandwidth ceiling (~150 fps aggregate per 02/06).

import { wait } from "../../src/utils"
import { recordProbeInput, type ProbeInput } from "../harness/input"
import { reportResult, status } from "../harness/report"

const params = {
  captureResolution: { width: 1280, height: 720 },
  sourceSeconds: 6,
  /** Longer than usual — surfaces thermal drift if CPU throttles. */
  runSeconds: 10,
  maxQueue: 8,
  passes: [
    { label: "hw-solo", n: 1, hardwareAcceleration: "prefer-hardware" as const },
    { label: "sw-solo", n: 1, hardwareAcceleration: "prefer-software" as const },
    { label: "hw-4", n: 4, hardwareAcceleration: "prefer-hardware" as const },
    { label: "sw-4", n: 4, hardwareAcceleration: "prefer-software" as const },
    { label: "sw-8", n: 8, hardwareAcceleration: "prefer-software" as const },
  ],
}

interface PerDecoderStats {
  id: number
  framesDecoded: number
  fps: number
  /** Optional split by quarter to surface throttle: first quarter
   *  vs last quarter of the run. */
  firstQuarterFps: number
  lastQuarterFps: number
}

interface PassReport {
  label: string
  n: number
  hardwareAcceleration: string
  totalFrames: number
  aggregateFps: number
  perDecoder: PerDecoderStats[]
  configured: boolean
  configureMs: number
  /** First-keyframe-decode latency, measured separately. */
  switchCostMs: number | null
  errors: string[]
}

async function measureSwitchCost(
  source: ProbeInput,
  hwAccel: HardwareAcceleration,
): Promise<number | null> {
  const { promise, resolve, reject } = Promise.withResolvers<VideoFrame>()
  const decoder = new VideoDecoder({
    output(frame) {
      resolve(frame)
    },
    error(error) {
      reject(error)
    },
  })
  try {
    decoder.configure({ ...source.config, hardwareAcceleration: hwAccel })
    const start = performance.now()
    decoder.decode(source.chunks[0])
    const frame = await promise
    const ms = performance.now() - start
    frame.close()
    decoder.close()
    return ms
  } catch {
    try {
      decoder.close()
    } catch {}
    return null
  }
}

async function runPass(
  source: ProbeInput,
  pass: (typeof params.passes)[number],
): Promise<PassReport> {
  status(`PASS [${pass.label}] N=${pass.n} hwAccel=${pass.hardwareAcceleration}`)
  const errors: string[] = []
  const stopped = { value: false }
  // Per-decoder counters with timestamped buckets for first/last quarter.
  const perDec: Array<{
    decoder: VideoDecoder
    framesDecoded: number
    firstQuarterFrames: number
    lastQuarterFrames: number
  }> = []
  let configured = true
  let configureMs = 0
  for (let d = 0; d < pass.n; d++) {
    const entry = {
      decoder: null as unknown as VideoDecoder,
      framesDecoded: 0,
      firstQuarterFrames: 0,
      lastQuarterFrames: 0,
    }
    entry.decoder = new VideoDecoder({
      output(frame) {
        entry.framesDecoded++
        frame.close()
      },
      error(error) {
        errors.push(`d${d}: ${error.message}`)
      },
    })
    try {
      const configureStart = performance.now()
      entry.decoder.configure({
        ...source.config,
        hardwareAcceleration: pass.hardwareAcceleration,
      })
      configureMs += performance.now() - configureStart
    } catch (error) {
      configured = false
      errors.push(`d${d} configure: ${error instanceof Error ? error.message : String(error)}`)
    }
    perDec.push(entry)
  }
  if (!configured) {
    return {
      label: pass.label,
      n: pass.n,
      hardwareAcceleration: pass.hardwareAcceleration,
      totalFrames: 0,
      aggregateFps: 0,
      perDecoder: [],
      configured: false,
      configureMs,
      switchCostMs: null,
      errors,
    }
  }

  // Take quarter-snapshots for thermal-drift detection.
  const quarterMs = (params.runSeconds * 1000) / 4
  const quarter1End = quarterMs
  const quarter4Start = quarterMs * 3
  const snapAt1: number[] = perDec.map(() => 0)
  const snapAt3: number[] = perDec.map(() => 0)
  const snapTimer1 = window.setTimeout(() => {
    for (let i = 0; i < perDec.length; i++) {
      snapAt1[i] = perDec[i].framesDecoded
    }
  }, quarter1End)
  const snapTimer3 = window.setTimeout(() => {
    for (let i = 0; i < perDec.length; i++) {
      snapAt3[i] = perDec[i].framesDecoded
    }
  }, quarter4Start)

  // Each decoder loops the source flat-out for runSeconds.
  const tasks = perDec.map(async entry => {
    while (!stopped.value) {
      for (const chunk of source.chunks) {
        if (stopped.value) {
          break
        }
        try {
          entry.decoder.decode(chunk)
        } catch (error) {
          errors.push(`decode: ${error instanceof Error ? error.message : String(error)}`)
          stopped.value = true
          break
        }
        while (entry.decoder.decodeQueueSize > params.maxQueue && !stopped.value) {
          await wait(1)
        }
      }
      if (stopped.value) {
        break
      }
      try {
        await entry.decoder.flush()
        entry.decoder.reset()
        entry.decoder.configure({
          ...source.config,
          hardwareAcceleration: pass.hardwareAcceleration,
        })
      } catch {
        break
      }
    }
  })

  await wait(params.runSeconds * 1000)
  stopped.value = true
  window.clearTimeout(snapTimer1)
  window.clearTimeout(snapTimer3)
  await Promise.all(tasks)
  // Cleanup
  for (const entry of perDec) {
    try {
      entry.decoder.close()
    } catch {}
  }

  const switchCostMs = await measureSwitchCost(source, pass.hardwareAcceleration)

  const totalFrames = perDec.reduce((s, p) => s + p.framesDecoded, 0)
  const perDecoder: PerDecoderStats[] = perDec.map((p, i) => ({
    id: i,
    framesDecoded: p.framesDecoded,
    fps: p.framesDecoded / params.runSeconds,
    firstQuarterFps: snapAt1[i] / (quarterMs / 1000),
    lastQuarterFps: (p.framesDecoded - snapAt3[i]) / (quarterMs / 1000),
  }))
  return {
    label: pass.label,
    n: pass.n,
    hardwareAcceleration: pass.hardwareAcceleration,
    totalFrames,
    aggregateFps: totalFrames / params.runSeconds,
    perDecoder,
    configured: true,
    configureMs,
    switchCostMs,
    errors,
  }
}

async function run(): Promise<void> {
  status(`software-decoder: ${params.passes.length} passes × ${params.runSeconds}s each`)

  status(`recording source clip (${params.sourceSeconds}s)...`)
  const source = await recordProbeInput(
    params.captureResolution.width,
    params.captureResolution.height,
    params.sourceSeconds,
  )
  status(`  got ${source.width}x${source.height}, ${source.chunks.length} chunks`)

  const reports: PassReport[] = []
  for (const pass of params.passes) {
    const report = await runPass(source, pass)
    reports.push(report)
    const driftSummary = report.perDecoder
      .map(d => `d${d.id}: ${d.firstQuarterFps.toFixed(0)}→${d.lastQuarterFps.toFixed(0)}fps`)
      .join(", ")
    status(
      `  [${report.label}] configured=${report.configured} aggregate=${report.aggregateFps.toFixed(1)}fps ` +
        `switchCost=${report.switchCostMs?.toFixed(1) ?? "n/a"}ms; ` +
        `drift: ${driftSummary}` +
        (report.errors.length > 0 ? `; errors=${report.errors.length}` : ""),
    )
  }
  status("done.")
  reportResult("software-decoder", params, { passes: reports })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("software-decoder", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
