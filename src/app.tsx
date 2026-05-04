import type { StoreSetter } from "@solidjs/signals"
import { createTrackedEffect, omit, storePath } from "@solidjs/signals"
import {
  ComponentProps,
  createContext,
  createSignal,
  createStore,
  For,
  Match,
  Switch,
  useContext,
} from "solid-js"
import styles from "./app.module.css"
import { Frame } from "./frame"
import type { Container, Entity, Mode, Node } from "./types"

type Selection = { path: Array<number>; depth: number }

export const Context = createContext<{
  layout: Container
  selection: Selection
  setSelection: StoreSetter<Selection>
  mode: () => Mode
  setMode: (mode: Mode) => void
}>()

function pathEquals(a: number[], b: number[]) {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function cloneNode(node: Node): Node {
  if (node.type === "entity") return { ...node }
  return { type: "container", direction: node.direction, children: node.children.map(cloneNode) }
}

function resolveNode(layout: Container, path: number[]) {
  let current: Entity | Container = layout

  for (let i = 0; i < path.length; i++) {
    if (current.type !== "container") {
      throw new Error("Unexpected entity node")
    }
    current = current.children[path[i]]
  }

  return current
}

function createEntity(): Entity {
  return {
    type: "entity",
    color: `rgb(${Math.random() * 100 + 150}, ${Math.random() * 100 + 150}, ${Math.random() * 100 + 150})`,
  }
}

function EntityFrame(
  props: ComponentProps<typeof Frame> & {
    entity: Entity
  },
) {
  const rest = omit(props, "entity")
  return <Frame style={{ background: props.entity?.color }} {...rest} />
}

function isNodeActive(path: number[], selection: Selection) {
  const pathLength = selection.path.length - selection.depth

  return (
    pathLength === path.length &&
    path.slice(0, pathLength).findIndex((value, index) => value !== selection.path[index]) === -1
  )
}

function NodeComponent(props: {
  layout: Node
  onAddFrame(path: number[], direction: "top" | "bottom" | "left" | "right"): void
  path: Array<number>
}) {
  const context = useContext(Context)
  const isActive = () => isNodeActive(props.path, context.selection)

  return (
    <Switch>
      <Match when={props.layout?.type === "container" && props.layout}>
        {layout => (
          <Frame
            active={isActive()}
            style={{ "flex-direction": layout().direction === "horizontal" ? "row" : "column" }}
            onAddFrame={direction => props.onAddFrame(props.path, direction)}
            class={styles.container}
          >
            <For each={layout().children}>
              {(child, index) => (
                <NodeComponent
                  layout={child()}
                  path={[...props.path, index()]}
                  onAddFrame={props.onAddFrame}
                />
              )}
            </For>
          </Frame>
        )}
      </Match>
      <Match when={props.layout?.type === "entity" && props.layout}>
        {entity => (
          <EntityFrame
            entity={entity()}
            active={isActive()}
            onAddFrame={direction => props.onAddFrame(props.path, direction)}
            onClick={() => {
              if (isNodeActive(props.path, { ...context.selection, depth: 0 })) {
                context.setSelection(selection => {
                  return {
                    ...selection,
                    depth: (selection.depth + 1) % (selection.path.length + 1),
                  }
                })
              } else {
                context.setSelection(() => ({ path: props.path, depth: 0 }))
              }
            }}
          />
        )}
      </Match>
    </Switch>
  )
}

export function App() {
  const [layout, setLayout] = createStore<Container>({
    type: "container",
    direction: "horizontal",
    children: [createEntity()],
  })

  const [selection, setSelection] = createStore<{ path: Array<number>; depth: number }>({
    path: [0],
    depth: 0,
  })

  const [mode, setMode] = createSignal<Mode>("append")

  createTrackedEffect(() => console.log([...selection.path]))

  function appendToContainer(containerPath: number[], insertAtStart: boolean) {
    const newEntity = createEntity()
    setLayout(proxy => {
      const container = resolveNode(proxy, containerPath) as Container
      if (insertAtStart) {
        container.children.unshift(newEntity)
      } else {
        container.children.push(newEntity)
      }
    })
    if (insertAtStart) {
      setSelection(() => ({ path: [...containerPath, 0], depth: 0 }))
    } else {
      const len = (resolveNode(layout, containerPath) as Container).children.length
      setSelection(() => ({ path: [...containerPath, len - 1], depth: 0 }))
    }
  }

  return (
    <Context value={{ layout, selection, setSelection, mode, setMode }}>
      <div style={{ display: "flex", width: "100vw", height: "100%" }}>
        <NodeComponent
          layout={layout}
          path={[]}
          onAddFrame={(path, direction) => {
            const node = resolveNode(layout, path)

            if (node.type === "entity") {
              console.log("onAddFrame", "entity")

              setLayout(proxy => {
                const container = resolveNode(proxy, path.slice(0, -1)) as Container
                container.children.splice(path[path.length - 1], 1, {
                  type: "container",
                  direction:
                    direction === "bottom" || direction === "top" ? "vertical" : "horizontal",
                  children:
                    direction === "top" || direction === "left"
                      ? [createEntity(), node]
                      : [node, createEntity()],
                })
              })

              setSelection(selection => {
                const newSelection = {
                  path: [...selection.path, direction === "top" || direction === "left" ? 0 : 1],
                  depth: 0,
                }

                console.log(newSelection.path)

                return newSelection
              })

              return
            }

            if (node.direction === "horizontal") {
              switch (direction) {
                case "bottom": {
                  setLayout(
                    storePath(
                      // @ts-expect-error
                      ...path.flatMap(path => ["children", path]),
                      {
                        type: "container",
                        direction: "vertical",
                        children: [{ ...node }, createEntity()],
                      },
                    ),
                  )
                  setSelection(() => ({ path: [...path, 1], depth: 0 }))

                  return
                }
                case "top": {
                  setLayout(
                    storePath(
                      // @ts-expect-error
                      ...path.flatMap(path => ["children", path]),
                      {
                        type: "container",
                        direction: "vertical",
                        children: [createEntity(), { ...node }],
                      },
                    ),
                  )
                  setSelection(() => ({ path: [...path, 0], depth: 0 }))
                  return
                }
              }
            } else if (node.direction === "vertical") {
              switch (direction) {
                case "left": {
                  setLayout(
                    storePath(
                      // @ts-expect-error
                      ...path.slice(0, -1).flatMap(path => ["children", path]),
                      value => {
                        if (value && value.type === "container") {
                          value.children.splice(path[path.length - 1], 0, createEntity())
                          return value
                        }

                        return {
                          type: "container",
                          direction: "horizontal",
                          children: [createEntity(), { ...node }],
                        }
                      },
                    ),
                  )

                  setSelection(() => ({ path: [...path], depth: 0 }))
                  return
                }
                case "right": {
                  setLayout(
                    storePath(
                      // @ts-expect-error
                      ...path.slice(0, -1).flatMap(path => ["children", path]),
                      value => {
                        if (value && value.type === "container") {
                          value.children.splice(path[path.length - 1] + 1, 0, createEntity())
                          return value
                        }
                        return {
                          type: "container",
                          direction: "horizontal",
                          children: [node, createEntity()],
                        }
                      },
                    ),
                  )
                  setSelection(() => ({ path: [...path.slice(0, -1), path[path.length - 1] + 1], depth: 0 }))
                  return
                }
              }
            }

            setLayout(proxy => {
              const node = resolveNode(proxy, path) as Container
              if (direction === "top" || direction === "left") {
                node.children.unshift(createEntity())
              } else {
                node.children.push(createEntity())
              }
            })

            if (direction === "top" || direction === "left") {
              setSelection(() => ({ path: [...path, 0], depth: 0 }))
            } else {
              const container = resolveNode(layout, path) as Container
              setSelection(() => ({ path: [...path, container.children.length - 1], depth: 0 }))
            }
          }}
        />
      </div>
    </Context>
  )
}
