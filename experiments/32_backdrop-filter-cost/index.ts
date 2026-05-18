// backdrop-filter-cost — measure per-frame cost of the production
// HUD's backdrop-filter on the target device. Two phases: baseline
// (no filter) and filtered. The cost is the delta.

import { wait } from "../../src/utils"
import { reportResult, status } from "../harness/report"

const params = {
  viewport: { width: 384, height: 699 },
  frames: 300,
  filter: "blur(10px) brightness(1.1) invert(0.25)",
}

interface PhaseResult {
  label: string
  samples: number
  p50Ms: number
  p95Ms: number
  maxMs: number
}

async function runPhase(label: string, filterCss: string): Promise<PhaseResult> {
  status(`PHASE ${label} (filter='${filterCss}')`)

  // Set up the painted div + a backdrop element below it. The backdrop
  // gives the filter something non-trivial to read through.
  const backdrop = document.createElement("div")
  backdrop.style.cssText = `
    position: fixed; inset: 0; z-index: 0;
    background: linear-gradient(45deg, #444, #222, #555);
  `
  document.body.appendChild(backdrop)
  const painted = document.createElement("div")
  painted.style.cssText = `
    position: fixed;
    left: ${(window.innerWidth - params.viewport.width) / 2}px;
    top: ${(window.innerHeight - params.viewport.height) / 2}px;
    width: ${params.viewport.width}px;
    height: ${params.viewport.height}px;
    z-index: 1;
    background: rgba(255, 255, 255, 0.1);
    backdrop-filter: ${filterCss};
  `
  document.body.appendChild(painted)

  // Force a layout flush before timing starts.
  void painted.offsetHeight

  const samples: number[] = []
  let lastFrameMs = performance.now()
  const { promise: done, resolve } = Promise.withResolvers<void>()

  function tick(): void {
    const now = performance.now()
    const delta = now - lastFrameMs
    lastFrameMs = now
    samples.push(delta)
    // Mutate the painted element each frame to force repaint.
    painted.style.transform = `translateZ(0) rotate(${(samples.length * 0.5) % 360}deg)`
    if (samples.length < params.frames) {
      requestAnimationFrame(tick)
    } else {
      resolve()
    }
  }
  requestAnimationFrame(tick)
  await done

  document.body.removeChild(painted)
  document.body.removeChild(backdrop)

  const sorted = samples.slice().sort((a, b) => a - b)
  const p50 = sorted[Math.floor(sorted.length * 0.5)]
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
  const max = sorted[sorted.length - 1]
  const result: PhaseResult = {
    label,
    samples: samples.length,
    p50Ms: p50,
    p95Ms: p95,
    maxMs: max,
  }
  status(
    `  ${label} p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms max=${max.toFixed(2)}ms`,
  )
  return result
}

async function run(): Promise<void> {
  status(`backdrop-filter-cost: ${params.frames} frames per phase`)
  // Settle before timing.
  await wait(500)
  const baseline = await runPhase("baseline", "none")
  await wait(500)
  const filtered = await runPhase("filtered", params.filter)

  const costP50 = filtered.p50Ms - baseline.p50Ms
  const costP95 = filtered.p95Ms - baseline.p95Ms
  status(`cost: p50=${costP50.toFixed(2)}ms p95=${costP95.toFixed(2)}ms`)

  reportResult("backdrop-filter-cost", params, {
    baseline,
    filtered,
    costP50,
    costP95,
  })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("backdrop-filter-cost", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
