import { NodeComponent } from "./components/node-component"
import { Context } from "./context"
import { Main } from "./hud/main"
import { LayoutBuilder } from "./layout-builder"
import { createAppState } from "./state"

console.log("[init]", JSON.stringify({ width: window.innerWidth, height: window.innerHeight }))

export function App() {
  const state = createAppState()

  return (
    <Context value={state}>
      <div style={{ display: "flex", width: "100vw", height: "100%", position: "relative" }}>
        <LayoutBuilder>
          <NodeComponent layout={state.app.layout} path={[]} onAddFrame={state.handleAddFrame} />
        </LayoutBuilder>
        <Main />
      </div>
    </Context>
  )
}
