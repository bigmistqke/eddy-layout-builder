import { createEffect, createMemo, For, onSettled, Show, useContext } from "solid-js"
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

function applyViewportToRect(rect: Rect, viewport: ViewportState): Rect {
  return {
    x: rect.x * viewport.scale + viewport.x,
    y: rect.y * viewport.scale + viewport.y,
    width: rect.width * viewport.scale,
    height: rect.height * viewport.scale,
  }
}

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
    const canvasX = (screenX - lastViewport.x) / lastViewport.scale
    const canvasY = (screenY - lastViewport.y) / lastViewport.scale
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
      // Leaves are computed at unscaled canvas dims — the renderer's
      // vertex shader applies the viewport scale + translation. Keeping
      // the canvas itself at viewport size sidesteps the browser layout
      // limit on huge transformed elements.
      const { leaves, selectedRect } = layoutFrames(
        context.app.layout,
        wrapperRect,
        context.app.selection,
      )
      lastLeaves = leaves
      lastSelectedRect = selectedRect
      lastViewport = viewport

      renderer.render(viewport, lastLeaves)

      // Test hook — snapshot of what the GL just drew.
      ;(window as unknown as { __layoutFrames?: () => unknown }).__layoutFrames = () => ({
        leaves: lastLeaves,
        selectedRect: lastSelectedRect,
        viewport,
        canvas: wrapperRect,
      })

      // Drive handle overlay CSS vars from selectedRect (in screen
      // space, after applying viewport transform).
      if (lastSelectedRect) {
        const screen = applyViewportToRect(lastSelectedRect, viewport)
        wrapperElement.style.setProperty("--selected-x", `${screen.x}px`)
        wrapperElement.style.setProperty("--selected-y", `${screen.y}px`)
        wrapperElement.style.setProperty("--selected-width", `${screen.width}px`)
        wrapperElement.style.setProperty("--selected-height", `${screen.height}px`)
      }
    }

    function recomputeViewport(): ViewportState {
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
      const transform = computeViewportTransform(
        context.app.layout,
        selectedPath,
        canvas,
        1,
        hudRects,
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

    // Drive viewport + animation from layout/selection changes.
    createEffect(
      () => layoutSignature(context.app.layout, context.app.selection),
      () => {
        const target = recomputeViewport()
        startAnimation(target)
      },
    )

    return () => {
      cancelTween?.()
      resizeObserver.disconnect()
      renderer.dispose()
    }
  })

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
