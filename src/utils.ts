import type { Container, Entity } from "./types"

export function resolveNode(layout: Container, path: number[]): Entity | Container {
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
