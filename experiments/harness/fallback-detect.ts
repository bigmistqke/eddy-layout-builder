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
