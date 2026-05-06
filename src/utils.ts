import type { Container, Entity } from "./types"

export function resolveNode(layout: Container, path: number[]): Entity | Container {
  let current: Entity | Container = layout
  for (let i = 0; i < path.length; i++) {
    if (current.type !== "container") {
      throw new Error("Unexpected entity node")
    }
    current = current.children[path[i]]
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
