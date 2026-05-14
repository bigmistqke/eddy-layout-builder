import { ErrorStrip } from "./components/error-strip"
import { Context } from "./context"
import { LayoutBuilder } from "./layout-builder"
import { createAppState } from "./state"

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
