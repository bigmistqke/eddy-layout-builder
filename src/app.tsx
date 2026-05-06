import { Match, Switch } from "solid-js"
import { NodeComponent } from "./components/node-component"
import { Context } from "./context"
import { Main } from "./hud/main"
import { LayoutBuilder } from "./layout-builder"
import { createAppState } from "./state"

export function App() {
  const state = createAppState()

  return (
    <Context value={state}>
      <div style={{ display: "flex", width: "100vw", height: "100%", position: "relative" }}>
        <Switch>
          <Match when={state.app.view.type === "recording"}>
            <div style={{ display: "flex", flex: 1, position: "relative" }}>
              <NodeComponent
                layout={state.app.layout}
                path={[]}
                onAddFrame={state.handleAddFrame}
              />
            </div>
          </Match>
          <Match when={state.app.view.type === "layout"}>
            <LayoutBuilder>
              <NodeComponent
                layout={state.app.layout}
                path={[]}
                onAddFrame={state.handleAddFrame}
              />
            </LayoutBuilder>
          </Match>
        </Switch>
        <Main />
      </div>
    </Context>
  )
}
