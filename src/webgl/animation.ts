import type { ViewportState } from "./renderer"

const ANIMATION_MS = 220

/** Ease-out cubic — fast start, slow finish. Beats smoothstep here:
 *  the symmetric curve had zero velocity at t=0, which reads as a
 *  "delay before motion starts" especially on zoom-in (where the eye
 *  expects the frame to begin growing immediately). With ease-out,
 *  the first paint after the click already shows ~25% of the motion. */
function ease(t: number): number {
  if (t <= 0) {
    return 0
  }
  if (t >= 1) {
    return 1
  }
  const inverted = 1 - t
  return 1 - inverted * inverted * inverted
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function lerpViewport(from: ViewportState, to: ViewportState, t: number): ViewportState {
  return {
    x: lerp(from.x, to.x, t),
    y: lerp(from.y, to.y, t),
    scale: lerp(from.scale, to.scale, t),
  }
}

/** Run a single rAF tween from `from` → `to`. `onTick(viewport)` fires
 *  every frame (including the final frame at t=1). `onSettle` fires
 *  once the tween completes. Returns a `cancel` function that stops
 *  the rAF loop without firing onSettle.
 *
 *  Animations are NOT chained — caller is responsible for cancelling
 *  any in-flight tween before starting a new one. */
export function animateViewport(
  from: ViewportState,
  to: ViewportState,
  onTick: (viewport: ViewportState) => void,
  onSettle: () => void,
  duration = ANIMATION_MS,
): () => void {
  const start = performance.now()
  let cancelled = false
  let rafHandle = 0

  function tick() {
    if (cancelled) {
      return
    }
    const elapsed = performance.now() - start
    const t = ease(Math.min(elapsed / duration, 1))
    const current = lerpViewport(from, to, t)
    onTick(current)
    if (elapsed < duration) {
      rafHandle = requestAnimationFrame(tick)
    } else {
      onSettle()
    }
  }

  rafHandle = requestAnimationFrame(tick)
  return () => {
    cancelled = true
    cancelAnimationFrame(rafHandle)
  }
}
