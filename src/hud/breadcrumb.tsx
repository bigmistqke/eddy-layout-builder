import {
  Accessor,
  createEffect,
  createMemo,
  createSignal,
  For,
  onSettled,
  Show,
  untrack,
  useContext,
} from "solid-js"
import { Context } from "../context"
import type { Node } from "../types"
import { logAction, rgbToCss } from "../utils"
import { layoutFrames } from "../viewport"
import styles from "./breadcrumb.module.css"
import { Hud } from "./hud"

/** Mirrors --color-red in index.css. Single accent that reads against
 *  both desaturated pastel cell fills and the dark container gutter. */
const COLOR_HIGHLIGHT = "#e94949"
const HIGHLIGHT_WIDTH = 2

function Minimap(props: { layout: Node; highlightPath: number[]; aspect: number }) {
  let canvasElement!: HTMLCanvasElement
  // Canvas display size is CSS-driven (width/height: 100%). When the
  // breadcrumb's scrollbar appears the button shrinks vertically and the
  // canvas's CSS height shrinks too — we observe that and resize the
  // bitmap to match. Width is locked at the full-size canvas width on
  // .button itself, so total content width stays stable across scrollbar
  // toggles (no resize-loop).
  const [size, setSize] = createSignal({ width: 0, height: 0 })
  onSettled(() => {
    if (!canvasElement) {
      return
    }
    const resizeObserver = new ResizeObserver(() => {
      const rect = canvasElement.getBoundingClientRect()
      setSize({ width: rect.width, height: rect.height })
    })
    resizeObserver.observe(canvasElement)
    return () => resizeObserver.disconnect()
  })
  createEffect(
    () => [props.layout, props.highlightPath, props.aspect, size()] as const,
    ([layout, highlightPath, aspect, currentSize]) => {
      if (!canvasElement || currentSize.width < 1 || currentSize.height < 1) {
        return
      }
      const devicePixelRatio = window.devicePixelRatio || 1
      canvasElement.width = currentSize.width * devicePixelRatio
      canvasElement.height = currentSize.height * devicePixelRatio
      const canvasContext = canvasElement.getContext("2d")!
      canvasContext.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0)
      // Letterbox the layout inside the canvas box — same idea as
      // object-fit: contain, done in the draw call so the bitmap matches
      // the canvas's actual pixel size with no wasted resolution.
      let drawWidth: number, drawHeight: number
      if (currentSize.width / currentSize.height > aspect) {
        drawHeight = currentSize.height
        drawWidth = drawHeight * aspect
      } else {
        drawWidth = currentSize.width
        drawHeight = drawWidth / aspect
      }
      const drawX = (currentSize.width - drawWidth) / 2
      const drawY = (currentSize.height - drawHeight) / 2
      canvasContext.clearRect(0, 0, currentSize.width, currentSize.height)
      const { leaves, selectedRect } = untrack(() =>
        layoutFrames(layout, { width: drawWidth, height: drawHeight }, {
          path: highlightPath,
          depth: 0,
          preview: false,
        }),
      )
      for (const leaf of leaves) {
        canvasContext.fillStyle = rgbToCss(leaf.color)
        canvasContext.fillRect(drawX + leaf.rect.x, drawY + leaf.rect.y, leaf.rect.width, leaf.rect.height)
      }
      if (selectedRect) {
        canvasContext.strokeStyle = COLOR_HIGHLIGHT
        canvasContext.lineWidth = HIGHLIGHT_WIDTH
        const inset = HIGHLIGHT_WIDTH / 2
        canvasContext.strokeRect(
          drawX + selectedRect.x + inset,
          drawY + selectedRect.y + inset,
          selectedRect.width - HIGHLIGHT_WIDTH,
          selectedRect.height - HIGHLIGHT_WIDTH,
        )
      }
    },
  )
  return <canvas ref={canvasElement} style={{ width: "100%", height: "100%", display: "block" }} />
}

export function Breadcrumb(props: { canvasAspect: Accessor<number> }) {
  const context = useContext(Context)!

  // Each segment carries the highlight path from the layout root to the
  // node-in-scope at that segment's depth. `depth` is the value
  // `selection.depth` should take when this segment is tapped.
  const segments = createMemo(() => {
    const selection = context.app.selection
    if (selection === null) {
      return []
    }
    const { path } = selection
    const result: Array<{ highlightPath: number[]; depth: number }> = []

    // Segment 0: root scope — empty highlight path means "this node (root)
    // is highlighted." Visually the entire minimap is outlined.
    result.push({ highlightPath: [], depth: path.length })

    let current: Node = context.app.layout
    for (let index = 0; index < path.length; index++) {
      if (current.type !== "container") {
        break
      }
      current = current.children[path[index]]
      const depth = path.length - 1 - index
      result.push({ highlightPath: path.slice(0, index + 1), depth })
    }

    return result
  })

  let contentElement!: HTMLDivElement
  // Scroll the trailing breadcrumb into view whenever the chain grows.
  createEffect(
    () => segments().length,
    count => {
      if (!contentElement || count === 0) {
        return
      }

      contentElement.scrollTo({ left: contentElement.scrollWidth, behavior: "smooth" })
    },
  )

  return (
    <Show
      when={
        (context.app.tool === "append" || context.app.tool === "split") &&
        context.app.selection
      }
    >
      {selection => (
        <Hud
          position="top-left"
          orientation="horizontal"
          contentClass={styles.content}
          contentRef={element => (contentElement = element)}
        >
          <For each={segments()}>
            {(segment, index) => (
              <Hud.Button
                active={segment().depth === selection().depth}
                class={styles.button}
                onClick={() => {
                  logAction("tap-breadcrumb", { depth: segment().depth, segmentIndex: index() })
                  context.setSelection({
                    path: selection().path,
                    depth: segment().depth,
                    preview: selection().preview,
                  })
                }}
              >
                <Minimap
                  layout={context.app.layout}
                  highlightPath={segment().highlightPath}
                  aspect={props.canvasAspect()}
                />
              </Hud.Button>
            )}
          </For>
        </Hud>
      )}
    </Show>
  )
}
