import { Show } from "solid-js"
import { Context } from "./context"
import { Main } from "./hud/main"
import { LayoutBuilder } from "./layout-builder"
import { NodeComponent } from "./node-component"
import { createAppState } from "./state"

export function App() {
  const state = createAppState()
  const { app, handleAddFrame, enterAppendMode, enterSplitMode, exitLayout } = state

  return (
    <Context value={state}>
      <div style={{ display: "flex", width: "100vw", height: "100%", position: "relative" }}>
        <Show when={app.view.type === "recording"}>
          <div style={{ display: "flex", flex: 1, position: "relative" }}>
            <NodeComponent layout={app.layout} path={[]} onAddFrame={handleAddFrame} />
          </div>
        </Show>
        <Show when={app.view.type === "layout"}>
          <LayoutBuilder>
            <NodeComponent layout={app.layout} path={[]} onAddFrame={handleAddFrame} />
          </LayoutBuilder>
        </Show>
        <Main
          onEnterLayout={enterAppendMode}
          onSetSplitMode={enterSplitMode}
          onExitLayout={exitLayout}
        />
      </div>
    </Context>
  )
}
