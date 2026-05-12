import type { JSX } from "solid-js"
import type { AppContext, Container, Entity, Node, Rgb } from "./types"

/** Pastel RGB triple — each channel in [~0.59, ~0.98]. Stored on
 *  Entity directly so renderers don't have to parse a string. */
function randomPastelRgb(): Rgb {
  return [
    (Math.random() * 100 + 150) / 255,
    (Math.random() * 100 + 150) / 255,
    (Math.random() * 100 + 150) / 255,
  ]
}

/** Build a fresh entity with a UUID id and a random pastel tint. */
export function createEntity(): Entity {
  return {
    type: "entity",
    id: crypto.randomUUID(),
    color: randomPastelRgb(),
  }
}

/** Format an Rgb triple for CSS contexts (canvas 2d fillStyle, CSS
 *  custom properties, etc.). */
export function rgbToCss(color: Rgb): string {
  return `rgb(${color[0] * 255}, ${color[1] * 255}, ${color[2] * 255})`
}

/**
 * Read `signal` and return null. Useful inside JSX expression slots
 * that need to subscribe to a tracked signal without rendering it —
 * e.g. to make a `<Loading>` boundary observe an async signal's
 * pending state while the real consumer is imperative (WebGL, etc.):
 *
 *   <Loading fallback={<Spinner />}>{track(asyncSignal)}</Loading>
 *
 * The JSX child expression is evaluated in a tracking scope, so the
 * read subscribes the parent boundary. While the signal is pending the
 * read throws NotReadyError, which Loading catches and renders the
 * fallback. When the signal resolves the expression re-evaluates, the
 * throw is gone, and Loading falls through to this null (nothing).
 */
export function track(signal: () => unknown): JSX.Element {
  signal()
  return null
}

export function resolveNode(layout: Node, path: number[]): Entity | Container {
  let current: Entity | Container = layout
  for (let index = 0; index < path.length; index++) {
    if (current.type !== "container") {
      throw new Error("Unexpected entity node")
    }
    current = current.children[path[index]]
  }
  return current
}

/**
 * Resolve the currently-selected entity's id, or null if no entity is
 * selected. Honours `selection.depth` (which collapses some tail of the
 * path to refer to an ancestor — matches canvas.tsx's hit-test logic).
 */
export function selectedCellId(context: AppContext): string | null {
  const selection = context.app.selection
  if (selection === null) {
    return null
  }
  const targetedPath = selection.path.slice(0, selection.path.length - selection.depth)
  const node = resolveNode(context.app.layout, targetedPath)
  return node.type === "entity" ? node.id : null
}

/**
 * Structured logging of user-input actions. Each log line has the form
 *   [action] {"type":"...", ...}
 * which makes it copy-pasteable into a Playwright test as a test step.
 *
 * Call sites are placed at every interactive UI handler. Don't add logs
 * for derived state changes — only for direct user inputs.
 */
export function logAction(type: string, payload?: Record<string, unknown>): void {
  console.log("[action]", JSON.stringify({ type, ...payload }))
}

/** Uppercase the first character of a string. */
export function capitalize<Input extends string>(value: Input): Capitalize<Input> {
  return (value.charAt(0).toUpperCase() + value.slice(1)) as Capitalize<Input>
}

export function pathEquals(first: number[], second: number[]) {
  return first.length === second.length && first.every((value, index) => value === second[index])
}

/** Short relative-time label ("just now", "5 m", "3 h", "2 d", or a
 *  formatted date for older entries). Used in the project list. */
export function formatTimeAgo(timestamp: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < 60) {
    return "just now"
  }
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.round(minutes / 60)
  if (hours < 24) {
    return `${hours}h`
  }
  const days = Math.round(hours / 24)
  if (days < 7) {
    return `${days}d`
  }
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })
}

/**
 * Resolve after `milliseconds`. Centralised so call sites stay free of
 * `new Promise(resolve => setTimeout(resolve, ...))` boilerplate.
 */
export function wait(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, milliseconds)
  return promise
}
