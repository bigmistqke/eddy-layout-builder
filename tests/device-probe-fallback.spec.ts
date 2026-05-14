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
