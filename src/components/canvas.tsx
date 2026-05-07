import {
  createEffect,
  createMemo,
  For,
  onSettled,
  Show,
  untrack,
  useContext,
} from "solid-js"
import { Context } from "../context"
import type { Direction, Node, Selection } from "../types"
import { logAction } from "../utils"
import {
  computeExtends,
  computeSticks,
  computeViewportTransform,
  frameRect,
  layoutFrames,
  type LeafFrame,
  type Rect,
} from "../viewport"
import { animateViewport } from "../webgl/animation"
import { createRenderer, type ViewportState } from "../webgl/renderer"
import { ArrowNotch } from "./notch"
import styles from "./canvas.module.css"

const HANDLE_DIRECTIONS: Direction[] = ["top", "bottom", "left", "right"]
const ZERO_BY_DIRECTION: Record<Direction, number> = { top: 0, bottom: 0, left: 0, right: 0 }

/** A signature of the layout topology + selection. Re-fires the
 *  viewport-recompute effect whenever any container's children list,
 *  any container's direction, or the selection changes. */
function layoutSignature(layout: Node, selection: Selection | null): string {
  function nodeSignature(node: Node): string {
    if (node.type === "entity") {
      return "e"
    }
    return `${node.direction[0]}(${node.children.map(nodeSignature).join(",")})`
  }
  const selectionPart =
    selection === null ? "_" : `${selection.path.join(".")}/${selection.depth}`
  return `${nodeSignature(layout)}|${selectionPart}`
}

export function Canvas() {
  const context = useContext(Context)!
  let canvasElement!: HTMLCanvasElement
  let wrapperElement!: HTMLDivElement

  // Captured each render so the click handler / test hook see the same
  // data the GL just drew.
  let lastLeaves: LeafFrame[] = []
  let lastSelectedRect: Rect | null = null
  let lastViewport: ViewportState = { x: 0, y: 0, scale: 1 }

  // Set during onSettled, cleared on dispose. The component-scope
  // createEffect below consults this for the actual functions to call.
  // Using a plain ref avoids creating reactive primitives inside the
  // owner-backed onSettled callback.
  let drive: { recompute: () => ViewportState; start: (target: ViewportState) => void } | null =
    null

  const selectedPathKey = createMemo(() => {
    const selection = context.app.selection
    if (selection === null) {
      return null
    }
    const targeted = selection.path.slice(0, selection.path.length - selection.depth)
    return targeted.join(".")
  })

  function onWrapperClick(event: MouseEvent) {
    if (context.app.tool === null) {
      return
    }
    const wrapperRect = wrapperElement.getBoundingClientRect()
    const screenX = event.clientX - wrapperRect.left
    const screenY = event.clientY - wrapperRect.top
    // Leaves are computed in *scaled-canvas* coordinates; the viewport
    // applies translation only (scale baked in via the flex math). So
    // hit-test space is screenX - viewport.x.
    const canvasX = screenX - lastViewport.x
    const canvasY = screenY - lastViewport.y
    for (const leaf of lastLeaves) {
      if (
        canvasX >= leaf.rect.x &&
        canvasX < leaf.rect.x + leaf.rect.width &&
        canvasY >= leaf.rect.y &&
        canvasY < leaf.rect.y + leaf.rect.height
      ) {
        logAction("tap-frame", { path: leaf.path })
        context.setSelection({ path: leaf.path, depth: 0 })
        return
      }
    }
  }

  onSettled(() => {
    const renderer = createRenderer(canvasElement)
    let cancelTween: (() => void) | undefined

    function drawAt(viewport: ViewportState) {
      const wrapperRect = wrapperElement.getBoundingClientRect()
      // Compute leaves at *scaled* canvas dims so flex math matches
      // `computeViewportTransform`'s realRect (fixed-pixel paddings/gaps
      // don't scale uniformly with the viewport). The renderer then
      // only applies translation; scale is already baked into the
      // leaves' positions and sizes.
      const scaledCanvas = {
        width: wrapperRect.width * viewport.scale,
        height: wrapperRect.height * viewport.scale,
      }
      const { leaves, selectedRect } = layoutFrames(
        context.app.layout,
        scaledCanvas,
        context.app.selection,
      )
      lastLeaves = leaves
      lastSelectedRect = selectedRect
      lastViewport = viewport

      // Translate-only viewport for the renderer (scale is baked in).
      const drawViewport: ViewportState = { x: viewport.x, y: viewport.y, scale: 1 }
      renderer.render(drawViewport, lastLeaves)

      // Test hook — snapshot of what the GL just drew. `viewport.scale`
      // here is reported as 1 because leaf rects are already in scaled
      // coordinates; tests apply `rect.x + viewport.x` for screen space.
      window.__layoutFrames = () => ({
        leaves: lastLeaves,
        selectedRect: lastSelectedRect,
        viewport: drawViewport,
        canvas: wrapperRect,
      })

      // Drive handle overlay CSS vars from selectedRect. Snap to whole
      // CSS pixels (matches the GL renderer's snap) so the overlay's
      // border and the WebGL frame edge land on the same device-pixel
      // column. Half-CSS-pixel snaps misalign on HiDPI — see
      // src/webgl/renderer.ts for the rationale.
      if (lastSelectedRect) {
        const x = Math.round(lastSelectedRect.x + viewport.x)
        const y = Math.round(lastSelectedRect.y + viewport.y)
        const right = Math.round(lastSelectedRect.x + viewport.x + lastSelectedRect.width)
        const bottom = Math.round(lastSelectedRect.y + viewport.y + lastSelectedRect.height)
        wrapperElement.style.setProperty("--selected-x", `${x}px`)
        wrapperElement.style.setProperty("--selected-y", `${y}px`)
        wrapperElement.style.setProperty("--selected-width", `${right - x}px`)
        wrapperElement.style.setProperty("--selected-height", `${bottom - y}px`)
      }
    }

    function recomputeViewport(): ViewportState {
      const t0 = performance.now()
      const wrapperRect = wrapperElement.getBoundingClientRect()
      const canvas = { width: wrapperRect.width, height: wrapperRect.height }
      const selection = context.app.selection
      if (selection === null) {
        const identity: ViewportState = { x: 0, y: 0, scale: 1 }
        context.setViewport(identity)
        context.setSelectedHandlesState({ extend: ZERO_BY_DIRECTION, stick: ZERO_BY_DIRECTION })
        return identity
      }
      const targetedDepth = selection.path.length - selection.depth
      const selectedPath = selection.path.slice(0, Math.max(0, targetedDepth))
      const hudRects = context.computeHudRects(wrapperRect)
      const tComputeStart = performance.now()
      const transform = computeViewportTransform(
        context.app.layout,
        selectedPath,
        canvas,
        1,
        hudRects,
      )
      const tComputeEnd = performance.now()
      // eslint-disable-next-line no-console
      console.log(
        `[recomputeViewport] depth=${selectedPath.length} compute=${(tComputeEnd - tComputeStart).toFixed(2)}ms total=${(tComputeEnd - t0).toFixed(2)}ms scale=${transform.scale.toFixed(2)}`,
      )
      const realRect = frameRect(context.app.layout, selectedPath, {
        width: canvas.width * transform.scale,
        height: canvas.height * transform.scale,
      })
      const postRect: Rect = {
        x: realRect.x + transform.x,
        y: realRect.y + transform.y,
        width: realRect.width,
        height: realRect.height,
      }
      const stick = computeSticks(postRect, canvas)
      const stuckRect: Rect = {
        x: postRect.x + stick.left,
        y: postRect.y + stick.top,
        width: postRect.width - stick.left - stick.right,
        height: postRect.height - stick.top - stick.bottom,
      }
      const extend = computeExtends(stuckRect, hudRects)
      context.setSelectedHandlesState({ extend, stick })
      context.setViewport(transform)
      return transform
    }

    function startAnimation(target: ViewportState) {
      cancelTween?.()
      const fromViewport = lastViewport
      // Skip the tween entirely when nothing visible changes — selecting
      // a sibling at the same zoom level is a viewport no-op, and we
      // don't want to flag isAnimating (which hides the handle overlay)
      // for 220ms of pointless lerp. drawAt still runs once so the
      // handle overlay's CSS vars catch up to the new selectedRect.
      const epsilon = 0.5
      if (
        Math.abs(fromViewport.x - target.x) < epsilon &&
        Math.abs(fromViewport.y - target.y) < epsilon &&
        Math.abs(fromViewport.scale - target.scale) < 0.001
      ) {
        drawAt(target)
        return
      }
      context.setIsAnimating(true)
      cancelTween = animateViewport(
        fromViewport,
        target,
        drawAt,
        () => {
          cancelTween = undefined
          context.setIsAnimating(false)
        },
      )
    }

    function syncSize() {
      const rect = wrapperElement.getBoundingClientRect()
      renderer.resize(rect.width, rect.height)
      const transform = recomputeViewport()
      drawAt(transform)
    }

    syncSize()
    const resizeObserver = new ResizeObserver(syncSize)
    resizeObserver.observe(wrapperElement)

    drive = { recompute: recomputeViewport, start: startAnimation }

    return () => {
      drive = null
      cancelTween?.()
      resizeObserver.disconnect()
      renderer.dispose()
    }
  })

  // Drive viewport + animation from layout/selection changes. The
  // compute callback reads `context.app.layout` / `selection` (via the
  // signature helper) so Solid tracks them; the effect re-fires when
  // they change. `drive` is only set after onSettled resolves.
  createEffect(
    () => layoutSignature(context.app.layout, context.app.selection),
    () => {
      if (drive === null) {
        return
      }
      const target = drive.recompute()
      drive.start(target)
    },
  )

  return (
    <div
      ref={wrapperElement}
      class={styles.canvasWrapper}
      onClick={onWrapperClick}
      data-canvas-inner="true"
    >
      <canvas ref={canvasElement} class={styles.glCanvas} />
      <Show
        when={
          !context.isAnimating() && context.app.tool !== null && selectedPathKey() !== null
        }
      >
        <div class={styles.handleOverlay} data-selected-path={selectedPathKey()!}>
          <For each={HANDLE_DIRECTIONS}>
            {direction => (
              <ArrowNotch
                direction={direction()}
                style={(() => {
                  // Only set the CSS vars when non-zero — tests check
                  // that an empty inline value means "no extension".
                  const state = context.selectedHandlesState()
                  const style: Record<string, string> = {}
                  const extend = state.extend[direction()]
                  const stick = state.stick[direction()]
                  if (extend > 0) {
                    style["--extend"] = `${extend}px`
                  }
                  if (stick > 0) {
                    style["--stick"] = `${stick}px`
                  }
                  return style
                })()}
                onClick={() => {
                  const selection = context.app.selection
                  if (selection === null) {
                    return
                  }
                  const targeted = selection.path.slice(
                    0,
                    selection.path.length - selection.depth,
                  )
                  const tool = context.app.tool
                  if (tool === null) {
                    return
                  }
                  logAction("add-frame", { path: targeted, direction: direction(), op: tool })
                  context.handleAddFrame(targeted, direction(), tool)
                }}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
