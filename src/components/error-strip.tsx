import { Show } from "solid-js"
import { dismissError, lastError } from "../utils"

/**
 * Fixed top-of-screen strip that surfaces the most recent unhandled
 * rejection routed through `run()` / `logError()`. Tap to dismiss.
 * Exists so async failures on touch devices (where DevTools isn't in
 * reach) don't disappear silently.
 */
export function ErrorStrip() {
  return (
    <Show when={lastError()}>
      {entry => (
        <div
          onClick={dismissError}
          style={{
            position: "fixed",
            top: "0",
            left: "0",
            right: "0",
            "z-index": "9999",
            padding: "8px 12px",
            background: "rgba(180, 30, 30, 0.92)",
            color: "white",
            font: "12px/1.4 ui-monospace, monospace",
            "white-space": "pre-wrap",
            "word-break": "break-word",
            cursor: "pointer",
          }}
        >
          <div style={{ "font-weight": "bold" }}>error: {entry().scope}</div>
          <div>{entry().error.message}</div>
          <div style={{ opacity: "0.7", "font-size": "10px", "margin-top": "4px" }}>
            tap to dismiss
          </div>
        </div>
      )}
    </Show>
  )
}
