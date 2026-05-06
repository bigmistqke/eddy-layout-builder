/**
 * Structured logging of user-input actions. Each log line has the form
 *   [action] {"type":"...", ...}
 * which makes it copy-pasteable into a Playwright test as a test step.
 *
 * Call sites are placed at every interactive UI handler. Don't add logs
 * for derived state changes — only for direct user inputs.
 */
export function logAction(type: string, payload?: Record<string, unknown>): void {
  // Single-line JSON so the log line copy-pastes cleanly.
  // eslint-disable-next-line no-console
  console.log("[action]", JSON.stringify({ type, ...payload }))
}
