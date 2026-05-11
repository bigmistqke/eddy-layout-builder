import type { JSX } from "solid-js"
import type { AppContext, Container, Entity, Node } from "./types"

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

/**
 * Resolve after `milliseconds`. Centralised so call sites stay free of
 * `new Promise(resolve => setTimeout(resolve, ...))` boilerplate.
 */
export function wait(milliseconds: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, milliseconds)
  return promise
}
