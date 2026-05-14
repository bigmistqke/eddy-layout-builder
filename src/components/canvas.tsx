import {
  createEffect,
  createMemo,
  Errored,
  For,
  Loading,
  onSettled,
  Show,
  untrack,
  useContext,
} from "solid-js"
import { Context } from "../context"
import { ArrowButton } from "../hud/hud"
import type { Direction, Node, Selection } from "../types"
import { logAction, track } from "../utils"
import { computeFrameAffordances } from "../frame-affordances"
import { layoutFrames, type LeafFrame, type Rect } from "../viewport"
import { animateViewport } from "../webgl/animation"
import { createRenderer, type TextureSource, type ViewportState } from "../webgl/renderer"
import styles from "./canvas.module.css"

const HANDLE_DIRECTIONS: Direction[] = ["top", "bottom", "left", "right"]

/** A signature of the layout topology + selection + tool. Re-fires the
 *  viewport-recompute effect whenever any container's children list, any
 *  container's direction, the selection, or the active tool changes —
 *  the tool gates whether the selection drives a zoom (song mode = no
 *  zoom; see frame-affordances). */
function layoutSignature(layout: Node, selection: Selection | null, tool: string | null): string {
  function nodeSignature(node: Node): string {
    if (node.type === "entity") {
      return "e"
    }
    return `${node.direction[0]}(${node.children.map(nodeSignature).join(",")})`
  }
  const selectionPart = selection === null ? "_" : `${selection.path.join(".")}/${selection.depth}`
  return `${nodeSignature(layout)}|${selectionPart}|${tool ?? "_"}`
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
  interface Drive {
    recompute(): ViewportState
    start(target: ViewportState): void
    startPlaybackLoop(): void
    stopPlaybackLoop(): void
    /** One-shot render. Used when clip-set changes at rest — the rAF
     *  loop isn't running, but we still want frame-0 to update. */
    requestRender(): void
  }
  let drive: Drive | null = null

  const selectedPathKey = createMemo(() => {
    const selection = context.app.selection
    if (selection === null) {
      return null
    }
    const targeted = selection.path.slice(0, selection.path.length - selection.depth)
    return targeted.join(".")
  })

  function onWrapperClick(event: MouseEvent) {
    // Cell selection works in any tool mode — handles only render when
    // a tool is active (see the <Show> below), but the underlying
    // selection signal also drives transport + recording.
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
        const selection = context.app.selection
        const sameAsSelected =
          selection !== null &&
          selection.depth === 0 &&
          selection.path.length === leaf.path.length &&
          selection.path.every((value, index) => value === leaf.path[index])
        if (sameAsSelected) {
          if (context.app.tool !== null) {
            // Tool mode: tapping the selected cell is a no-op. The
            // selection drives handle visibility; deselecting on a
            // same-cell tap would surprise users mid-layout-edit.
            return
          }
          if (selection.preview) {
            // Song mode + preview active → deselect entirely.
            context.setSelection(null)
          } else {
            // Song mode + post-record state: re-activate preview without
            // changing selection.
            context.setSelection({ ...selection, preview: true })
          }
          return
        }
        // In edit mode, only auto-preview cells without a clip — once
        // a clip exists the user is mid-layout, not mid-recording, and
        // popping the camera back over recorded footage is jarring.
        // Song mode keeps preview=true so the camera follows selection.
        const previewOnSelect =
          context.app.tool === null || !context.clips.cellIds().includes(leaf.id)
        context.setSelection({ path: leaf.path, depth: 0, preview: previewOnSelect })
        return
      }
    }
  }

  onSettled(() => {
    const renderer = createRenderer(canvasElement)
    let cancelTween: (() => void) | undefined

    function gatherFrames(): Map<string, TextureSource> {
      return untrack(() => {
        const frames = new Map<string, TextureSource>()

        // Live camera preview goes into the preview target cell, if any.
        const previewCell = context.previewTargetCellId()
        if (previewCell !== null) {
          const previewElement = context.preview.element
          if (previewElement.videoWidth > 0 && previewElement.videoHeight > 0) {
            frames.set(previewCell, previewElement)
          }
        }

        // Clip frames. When playing, use transport position; otherwise
        // show frame 0 of each clip so cells stay visible at rest.
        const playing = context.transport.state() === "playing"
        const positionMicros = playing ? Math.round(context.transport.position() * 1_000_000) : 0
        const allClips = context.clips.clips
        for (const cellId of Object.keys(allClips)) {
          if (frames.has(cellId)) {
            continue
          }
          const clip = allClips[cellId]
          if (clip === undefined) {
            continue
          }
          const bitmap = clip.video.frameAt(positionMicros)
          if (bitmap !== null) {
            frames.set(cellId, bitmap)
          }
        }
        return frames
      })
    }

    function closeTransientFrames(frames: Map<string, TextureSource>) {
      for (const source of frames.values()) {
        if (source instanceof VideoFrame) {
          source.close()
        }
      }
    }

    function drawAt(viewport: ViewportState) {
      const wrapperRect = wrapperElement.getBoundingClientRect()
      // Compute leaves at *scaled* canvas dims so flex math matches the
      // viewport transform (fixed-pixel paddings/gaps don't scale
      // uniformly with the viewport). The renderer then only applies
      // translation; scale is already baked into the leaves' positions
      // and sizes.
      const scaledCanvas = {
        width: wrapperRect.width * viewport.scale,
        height: wrapperRect.height * viewport.scale,
      }
      // Layout tiles the scaled canvas edge-to-edge — see ADR-0001.
      const { leaves, selectedRect } = untrack(() =>
        layoutFrames(context.app.layout, scaledCanvas, context.app.selection),
      )
      lastLeaves = leaves
      lastSelectedRect = selectedRect
      lastViewport = viewport

      // Translate-only viewport for the renderer (scale is baked in).
      const drawViewport: ViewportState = { x: viewport.x, y: viewport.y, scale: 1 }
      // Include clip/preview frames so layout animations don't strip them.
      const frames = gatherFrames()
      renderer.render(drawViewport, lastLeaves, frames.size > 0 ? frames : undefined)
      closeTransientFrames(frames)

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

      // Camera-loading overlay CSS vars: write the preview target cell's
      // rect so the spinner can sit on top of it while gUM resolves.
      const previewId = untrack(context.previewTargetCellId)
      if (previewId !== null) {
        const previewLeaf = lastLeaves.find(leaf => leaf.id === previewId)
        if (previewLeaf !== undefined) {
          const x = Math.round(previewLeaf.rect.x + viewport.x)
          const y = Math.round(previewLeaf.rect.y + viewport.y)
          const right = Math.round(previewLeaf.rect.x + previewLeaf.rect.width + viewport.x)
          const bottom = Math.round(previewLeaf.rect.y + previewLeaf.rect.height + viewport.y)
          wrapperElement.style.setProperty("--preview-x", `${x}px`)
          wrapperElement.style.setProperty("--preview-y", `${y}px`)
          wrapperElement.style.setProperty("--preview-width", `${right - x}px`)
          wrapperElement.style.setProperty("--preview-height", `${bottom - y}px`)
        }
      }
    }

    function recomputeViewport(): ViewportState {
      // Solid store proxies track on EVERY property access, so wrap the
      // whole body in one untrack scope.
      return untrack(() => {
        const wrapperRect = wrapperElement.getBoundingClientRect()
        const canvas = { width: wrapperRect.width, height: wrapperRect.height }
        const selection = context.app.selection
        // App-mode policy lives here, not in the module: song mode (no
        // tool) and no-selection both mean "no frame to zoom" — pass
        // null. computeFrameAffordances knows nothing about tools.
        const path =
          selection === null || context.app.tool === null
            ? null
            : selection.path.slice(
                0,
                Math.max(0, selection.path.length - selection.depth),
              )
        const affordances = computeFrameAffordances(
          context.app.layout,
          path,
          canvas,
          context.hudRects(),
        )
        context.setViewport(affordances.viewport)
        context.setSelectedHandlesState(affordances.handles)
        return affordances.viewport
      })
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
      cancelTween = animateViewport(fromViewport, target, drawAt, () => {
        cancelTween = undefined
        context.setIsAnimating(false)
      })
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

    // ---- Playback render loop ----
    // Runs while transport is playing or a recording preview is active.
    // Reads clip + preview state via untrack — the loop itself is an
    // unowned rAF callback, no reactive dependencies.
    let playbackRaf = 0
    let lastPlaybackPosition = 0

    function playbackTick() {
      // Loop transition: transport.position() reset to ~0. Reset each
      // video source so frameAt for small t doesn't return stale frames.
      const positionSeconds = untrack(context.transport.position)
      if (positionSeconds < lastPlaybackPosition - 0.1) {
        const allClips = untrack(() => context.clips.clips)
        for (const cellId of Object.keys(allClips)) {
          allClips[cellId]?.video.reset()
        }
      }
      lastPlaybackPosition = positionSeconds

      const frames = gatherFrames()
      const drawViewport: ViewportState = { x: lastViewport.x, y: lastViewport.y, scale: 1 }
      renderer.render(drawViewport, lastLeaves, frames.size > 0 ? frames : undefined)
      closeTransientFrames(frames)
      const previewActive = untrack(context.previewTargetCellId) !== null
      const transportPlaying = untrack(context.transport.state) === "playing"
      // Keep ticking while transport is playing or a live preview is
      // visible — both produce changing pixels. When neither, the static
      // clip-frame-0 picture is stable, so stop the rAF and rely on
      // explicit re-renders (triggered by createEffect watchers below).
      if (previewActive || transportPlaying) {
        playbackRaf = requestAnimationFrame(playbackTick)
      } else {
        playbackRaf = 0
      }
    }

    function startPlaybackLoop() {
      if (playbackRaf !== 0) {
        return
      }
      playbackRaf = requestAnimationFrame(playbackTick)
    }

    function stopPlaybackLoop() {
      if (playbackRaf !== 0) {
        cancelAnimationFrame(playbackRaf)
        playbackRaf = 0
      }
    }

    function requestRender() {
      // One-shot render. No-op if the rAF loop is already running (the
      // next tick will pick up the change).
      if (playbackRaf !== 0) {
        return
      }
      const frames = gatherFrames()
      const drawViewport: ViewportState = { x: lastViewport.x, y: lastViewport.y, scale: 1 }
      renderer.render(drawViewport, lastLeaves, frames.size > 0 ? frames : undefined)
      closeTransientFrames(frames)
    }

    drive = {
      recompute: recomputeViewport,
      start: startAnimation,
      startPlaybackLoop,
      stopPlaybackLoop,
      requestRender,
    }

    return () => {
      drive = null
      cancelTween?.()
      stopPlaybackLoop()
      resizeObserver.disconnect()
      renderer.dispose()
    }
  })

  // Drive viewport + animation from layout/selection changes. The
  // compute callback reads `context.app.layout` / `selection` (via the
  // signature helper) so Solid tracks them; the effect re-fires when
  // they change. `drive` is only set after onSettled resolves.
  // Start/stop the playback rAF loop based on transport + preview state.
  createEffect(
    () => ({
      previewActive: context.previewTargetCellId() !== null,
      transportPlaying: context.transport.state() === "playing",
    }),
    ({ previewActive, transportPlaying }) => {
      if (drive === null) {
        return
      }
      if (previewActive || transportPlaying) {
        drive.startPlaybackLoop()
      } else {
        drive.stopPlaybackLoop()
      }
    },
  )

  // Re-render once when the set of clips changes — adding/removing a
  // clip changes the "frame 0 snapshot" we want to show at rest.
  createEffect(
    () => context.clips.cellIds().join("|"),
    () => {
      if (drive === null) {
        return
      }
      drive.requestRender()
    },
  )

  createEffect(
    () => {
      const signature = layoutSignature(
        context.app.layout,
        context.app.selection,
        context.app.tool,
      )
      // Track HUD geometry too — a HUD resizing on its own must
      // re-run handle/viewport math (see candidate #2).
      const rects = context.hudRects()
      return `${signature}|${rects.length}:${rects
        .map(r => `${Math.round(r.width)}x${Math.round(r.height)}`)
        .join(",")}`
    },
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
      ref={element => {
        wrapperElement = element
        context.setCanvasViewportElement(element)
      }}
      class={styles.canvasWrapper}
      onClick={onWrapperClick}
      data-canvas-inner="true"
    >
      <canvas ref={canvasElement} class={styles.glCanvas} />
      <Show when={context.previewTargetCellId() !== null}>
        <Errored fallback={null}>
          <Loading
            fallback={<div class={styles.cameraLoader} data-testid="camera-loader" />}
            children={track(context.preview.stream)}
          />
        </Errored>
      </Show>
      <Show
        when={
          !context.isAnimating() &&
          (context.app.tool === "append" || context.app.tool === "split") &&
          selectedPathKey() !== null
        }
      >
        <div class={styles.handleOverlay} data-selected-path={selectedPathKey()!}>
          <For each={HANDLE_DIRECTIONS}>
            {direction => (
              <ArrowButton
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
                  const targeted = selection.path.slice(0, selection.path.length - selection.depth)
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
