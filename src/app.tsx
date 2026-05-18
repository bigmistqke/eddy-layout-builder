import * as mediabunny from "mediabunny"
import { ErrorStrip } from "./components/error-strip"
import { Context } from "./context"
import { LayoutBuilder } from "./layout-builder"
import { createAppState } from "./state"

// Expose mediabunny on window for tests that need to demux blobs from
// OPFS (e.g. A/V sync verification). Strictly read-only — the app
// itself imports mediabunny directly.
;(window as unknown as { __mediabunny: typeof mediabunny }).__mediabunny = mediabunny

console.log("[init]", JSON.stringify({ width: window.innerWidth, height: window.innerHeight }))

export function App() {
  const state = createAppState()
  window.__appContext = state

  return (
    <Context value={state}>
      <div style={{ width: "100vw", height: "100vh", position: "relative" }}>
        <LayoutBuilder />
        <ErrorStrip />
      </div>
    </Context>
  )
}
