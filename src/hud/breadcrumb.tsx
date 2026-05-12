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
import styles from "./breadcrumb.module.css"
import { Hud } from "./hud"

const COLOR_CONTAINER = "#1a1a1a"
/** Mirrors --color-red in index.css. Single accent that reads against
 *  both desaturated pastel cell fills and the dark container gutter. */
const COLOR_HIGHLIGHT = "#e94949"
const HIGHLIGHT_WIDTH = 2
const GAP = 0

/** Draw the layout tree onto a canvas, outlining the highlighted node. */
function drawNode(
  canvasContext: CanvasRenderingContext2D,
  node: Node,
  highlightPath: number[],
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const isHighlighted = highlightPath.length === 0
  if (node.type === "entity") {
    // Use each entity's own colour so the breadcrumb minimap visually
    // matches the WebGL canvas's cell tint.
    canvasContext.fillStyle = rgbToCss(node.color)
    canvasContext.fillRect(x, y, width, height)
  } else {
    canvasContext.fillStyle = COLOR_CONTAINER
    canvasContext.fillRect(x, y, width, height)
    const childCount = node.children.length
    if (node.direction === "horizontal") {
      const childWidth = (width - GAP * (childCount - 1)) / childCount
      for (let index = 0; index < childCount; index++) {
        const childHighlight = index === highlightPath[0] ? highlightPath.slice(1) : [-1]
        drawNode(
          canvasContext,
          node.children[index],
          childHighlight,
          x + index * (childWidth + GAP),
          y,
          childWidth,
          height,
        )
      }
    } else {
      const childHeight = (height - GAP * (childCount - 1)) / childCount
      for (let index = 0; index < childCount; index++) {
        const childHighlight = index === highlightPath[0] ? highlightPath.slice(1) : [-1]
        drawNode(
          canvasContext,
          node.children[index],
          childHighlight,
          x,
          y + index * (childHeight + GAP),
          width,
          childHeight,
        )
      }
    }
  }
  if (isHighlighted) {
    canvasContext.strokeStyle = COLOR_HIGHLIGHT
    canvasContext.lineWidth = HIGHLIGHT_WIDTH
    const inset = HIGHLIGHT_WIDTH / 2
    canvasContext.strokeRect(
      x + inset,
      y + inset,
      width - HIGHLIGHT_WIDTH,
      height - HIGHLIGHT_WIDTH,
    )
  }
}

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
      canvasContext.clearRect(0, 0, currentSize.width, currentSize.height)
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
      untrack(() =>
        drawNode(canvasContext, layout, highlightPath, drawX, drawY, drawWidth, drawHeight),
      )
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
          kind="breadcrumb"
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
