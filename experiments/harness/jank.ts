// Standard jank measurement for render-loop experiments.
//
// The lesson from 18d: mean fps lies about perceived smoothness when
// the frame-time distribution is bimodal. K=9 streaming had recordFps
// 34.4 (looks fine) but 46% of frames over 33ms (visibly janky). And
// 5 slow frames in a row feel much worse than 5 scattered.
//
// This helper standardizes the metrics every render-loop experiment
// should emit so results across the series are comparable:
//   - mean / median / p95 / p99 / max
//   - counts over 16 / 33 / 50 / 100 ms thresholds (multiple buckets,
//     not just one)
//   - longest consecutive-jank streak (the "freeze" signal)
//   - jankScore: sum((t-budget)² for t>budget) / N, budget=33ms.
//     Penalises long hitches heavily. 0 = perfect. Lower = smoother.
//   - 10 ms-bucket histogram for distribution-shape inspection
//   - longtasks observed via PerformanceObserver (independent
//     measurement of main-thread tasks > 50ms — catches the *cause*
//     of jank, not just the symptom)

export interface JankReport {
  framesObserved: number
  meanMs: number
  medianMs: number
  p95Ms: number
  p99Ms: number
  maxMs: number
  /** Frames whose time was greater than each threshold. */
  over16ms: number
  over33ms: number
  over50ms: number
  over100ms: number
  /** Percent (0..1) of frames over 33ms. The honest perceived-
   *  smoothness signal per 18d's verdict. */
  over33msRatio: number
  /** Longest streak of consecutive frames over 33ms (= longest
   *  perceived freeze). */
  longestJankStreak: number
  /** Single number: lower = smoother, 0 = perfect.
   *  sum((t - 33)² for t > 33ms) / framesObserved. */
  jankScore: number
  /** Frame-time histogram in 10ms buckets, [0,10) [10,20) ... [200,∞). */
  histogramMs: number[]
}

export interface LongTaskReport {
  /** Number of longtask entries observed (tasks > 50ms). */
  observed: number
  /** Sum of all longtask durations. */
  totalDurationMs: number
  /** Longest single longtask. */
  longestMs: number
}

export class JankRecorder {
  private times: number[] = []
  private lastTimeMs: number | null = null

  /** Call once per frame, e.g. at the start of a rAF callback. */
  mark(now: number = performance.now()): void {
    if (this.lastTimeMs !== null) {
      this.times.push(now - this.lastTimeMs)
    }
    this.lastTimeMs = now
  }

  reset(): void {
    this.times = []
    this.lastTimeMs = null
  }

  /** Compute a JankReport over all marks so far. Doesn't clear. */
  snapshot(): JankReport {
    return computeJankReport(this.times)
  }

  /** Compute a report over marks so far, then reset. Useful for
   *  per-stage metrics: call slice() at the boundary of each stage. */
  slice(): JankReport {
    const report = this.snapshot()
    this.reset()
    return report
  }
}

export function computeJankReport(frameTimes: readonly number[]): JankReport {
  if (frameTimes.length === 0) {
    return {
      framesObserved: 0,
      meanMs: 0,
      medianMs: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0,
      over16ms: 0,
      over33ms: 0,
      over50ms: 0,
      over100ms: 0,
      over33msRatio: 0,
      longestJankStreak: 0,
      jankScore: 0,
      histogramMs: new Array(21).fill(0),
    }
  }
  const sorted = [...frameTimes].sort((a, b) => a - b)
  const sum = frameTimes.reduce((a, b) => a + b, 0)
  const pickPercentile = (p: number): number => {
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p))
    return sorted[idx]
  }
  let over16 = 0
  let over33 = 0
  let over50 = 0
  let over100 = 0
  let longestStreak = 0
  let currentStreak = 0
  let jankSum = 0
  const histogram = new Array(21).fill(0)
  for (const t of frameTimes) {
    if (t > 16) {
      over16++
    }
    if (t > 33) {
      over33++
      currentStreak++
      if (currentStreak > longestStreak) {
        longestStreak = currentStreak
      }
      const excess = t - 33
      jankSum += excess * excess
    } else {
      currentStreak = 0
    }
    if (t > 50) {
      over50++
    }
    if (t > 100) {
      over100++
    }
    const bucket = Math.min(20, Math.floor(t / 10))
    histogram[bucket]++
  }
  return {
    framesObserved: frameTimes.length,
    meanMs: sum / frameTimes.length,
    medianMs: pickPercentile(0.5),
    p95Ms: pickPercentile(0.95),
    p99Ms: pickPercentile(0.99),
    maxMs: sorted[sorted.length - 1],
    over16ms: over16,
    over33ms: over33,
    over50ms: over50,
    over100ms: over100,
    over33msRatio: over33 / frameTimes.length,
    longestJankStreak: longestStreak,
    jankScore: jankSum / frameTimes.length,
    histogramMs: histogram,
  }
}

/** Observe `longtask` PerformanceEntries until stop() is called. Catches
 *  main-thread tasks > 50ms — the typical *cause* of frame-time spikes.
 *  Browsers that don't support the longtask API return an empty report. */
export function observeLongTasks(): { stop(): LongTaskReport } {
  const longTasks: PerformanceEntry[] = []
  let observer: PerformanceObserver | null = null
  try {
    observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        longTasks.push(entry)
      }
    })
    observer.observe({ entryTypes: ["longtask"] })
  } catch {
    // longtask API unavailable — skip
  }
  return {
    stop() {
      if (observer !== null) {
        observer.disconnect()
      }
      const durations = longTasks.map(e => e.duration)
      return {
        observed: longTasks.length,
        totalDurationMs: durations.reduce((a, b) => a + b, 0),
        longestMs: durations.length === 0 ? 0 : Math.max(...durations),
      }
    },
  }
}
