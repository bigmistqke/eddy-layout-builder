import { Accessor, createEffect, createMemo, For, useContext } from "solid-js"
import { Notch } from "../components/notch"
import { Context } from "../context"
import type { Container, Node } from "../types"
import { logAction } from "../utils"
import styles from "./breadcrumb.module.css"

const COLOR_CONTAINER = "#1a1a1a"
const COLOR_CELL = "#444"
const COLOR_HIGHLIGHT = "rgb(216, 216, 216)"
const HIGHLIGHT_WIDTH = 2
const GAP = 1

/** Draw the layout tree onto a canvas, outlining the highlighted node. */
function drawNode(
  ctx: CanvasRenderingContext2D,
  node: Node,
  hl: number[],
  x: number,
  y: number,
  w: number,
  h: number,
) {
  const isHl = hl.length === 0
  if (node.type === "entity") {
    ctx.fillStyle = COLOR_CELL
    ctx.fillRect(x, y, w, h)
  } else {
    ctx.fillStyle = COLOR_CONTAINER
    ctx.fillRect(x, y, w, h)
    const n = node.children.length
    if (node.direction === "horizontal") {
      const childW = (w - GAP * (n - 1)) / n
      for (let i = 0; i < n; i++) {
        const childHl = i === hl[0] ? hl.slice(1) : [-1]
        drawNode(ctx, node.children[i], childHl, x + i * (childW + GAP), y, childW, h)
      }
    } else {
      const childH = (h - GAP * (n - 1)) / n
      for (let i = 0; i < n; i++) {
        const childHl = i === hl[0] ? hl.slice(1) : [-1]
        drawNode(ctx, node.children[i], childHl, x, y + i * (childH + GAP), w, childH)
      }
    }
  }
  if (isHl) {
    ctx.strokeStyle = COLOR_HIGHLIGHT
    ctx.lineWidth = HIGHLIGHT_WIDTH
    const inset = HIGHLIGHT_WIDTH / 2
    ctx.strokeRect(x + inset, y + inset, w - HIGHLIGHT_WIDTH, h - HIGHLIGHT_WIDTH)
  }
}

function Minimap(props: {
  layout: Container
  highlightPath: number[]
  width: number
  height: number
}) {
  let canvasEl!: HTMLCanvasElement
  createEffect(
    () => [props.layout, props.highlightPath, props.width, props.height] as const,
    ([layout, highlightPath, width, height]) => {
      if (!canvasEl) return
      const dpr = window.devicePixelRatio || 1
      canvasEl.width = width * dpr
      canvasEl.height = height * dpr
      const ctx = canvasEl.getContext("2d")!
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, height)
      drawNode(ctx, layout, highlightPath, 0, 0, width, height)
    },
  )
  return (
    <canvas
      ref={canvasEl}
      style={{ width: `${props.width}px`, height: `${props.height}px`, display: "block" }}
    />
  )
}

export function Breadcrumb(props: { canvasAspect: Accessor<number> }) {
  const context = useContext(Context)!

  // Each segment carries the highlight path from the layout root to the
  // node-in-scope at that segment's depth. `depth` is the value
  // `selection.depth` should take when this segment is tapped.
  const segments = createMemo(() => {
    const { path } = context.selection
    const segs: Array<{ highlightPath: number[]; depth: number }> = []

    // Segment 0: root scope — empty highlight path means "this node (root)
    // is highlighted." Visually the entire minimap is outlined.
    segs.push({ highlightPath: [], depth: path.length })

    let current: Node = context.app.layout
    for (let i = 0; i < path.length; i++) {
      if (current.type !== "container") break
      current = current.children[path[i]]
      const depth = path.length - 1 - i
      segs.push({ highlightPath: path.slice(0, i + 1), depth })
    }

    return segs
  })

  // Canvas dictates the size; the button wraps it with its own padding
  // and margin (4 + 4 = 8 each side, see breadcrumb.module.css). Pick the
  // canvas height so the button outer = hud height: 60 − (margin 4 + padding 4) × 2 = 44.
  const CANVAS_HEIGHT = 44
  const canvasWidth = () => Math.max(8, Math.round(CANVAS_HEIGHT * props.canvasAspect()))

  return (
    <Notch ref={context.setBreadcrumbEl} class={styles.notch} orientation="top">
      <div class={styles.content}>
        <For each={segments()}>
          {(seg, i) => (
            <button
              class={[
                styles.button,
                seg().depth === context.selection.depth ? styles.active : "",
              ].join(" ")}
              onClick={() => {
                logAction("tap-breadcrumb", { depth: seg().depth, segmentIndex: i() })
                context.setSelection(s => ({ ...s, depth: seg().depth }))
              }}
            >
              <Minimap
                layout={context.app.layout}
                highlightPath={seg().highlightPath}
                width={canvasWidth()}
                height={CANVAS_HEIGHT}
              />
            </button>
          )}
        </For>
      </div>
    </Notch>
  )
}
