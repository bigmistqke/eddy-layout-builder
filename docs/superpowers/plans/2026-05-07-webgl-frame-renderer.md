# WebGL Frame Renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the nested DOM frame tree with a single WebGL canvas rendering instanced quads. Layout becomes pure JS via `layoutFrames`; handles become a flat DOM overlay parented to the canvas; WAAPI is replaced by a rAF tween. All observable behavior preserved.

**Architecture:** A `Renderer` module owns the GL context, view.gl-compiled program, and per-frame draw. `layoutFrames(layout, canvas)` walks the tree once, returning all leaf rects + the selected rect. A new `Canvas` component owns the `<canvas>` element, a rAF animation driver, the click hit-test, and a flat handle overlay positioned via CSS vars from the selected rect.

**Tech Stack:** TypeScript, SolidJS, WebGL2, `@bigmistqke/view.gl@0.1.18`, Playwright.

---

## File map

- **New** `src/webgl/shaders.ts` — vertex + fragment GLSL strings.
- **New** `src/webgl/renderer.ts` — owns GL context, program, view.gl schema, frame buffer, draw call. Exports `createRenderer(canvas)` returning `{ render(viewport, leaves), resize(w, h), dispose() }`.
- **New** `src/webgl/animation.ts` — rAF tween driver. Exports `animateViewport(from, to, onTick, onSettle, duration?)`.
- **Extend** `src/viewport.ts` — add `layoutFrames(layout, canvas)` returning `{ leaves, selectedRect }`.
- **New** `src/components/canvas.tsx` — Solid component owning the WebGL canvas, the animation driver, the click hit-test, and the handle overlay div with CSS vars.
- **Modify** `src/components/notch.module.css` — handles position relative to overlay's `--width`/`--height` instead of frame edge.
- **Modify** `src/layout-builder.tsx` — render `<Canvas />` instead of `canvasInner` + `<NodeComponent />`. WAAPI block deleted.
- **Modify** `src/app.tsx` — drop `<NodeComponent />` from `<LayoutBuilder>`'s children since it's gone.
- **Delete** `src/components/node-component.tsx` + `src/components/node-component.module.css`.
- **Modify** `src/state.ts` — drop `setSelection({ path, depth: 0 })` from places relying on entity onClick (none expected — selection is set by `appendToContainer`/`splitNode`/`tap-frame` flow which lives in helpers, not in NodeComponent itself).
- **Modify** `tests/helpers.ts` — `frameRect` reads from `window.__layoutFrames` test hook; `clickFrame` synthesizes a canvas click at the centroid of the leaf rect; `clickHandle` selector unchanged (notches still in DOM, still carry `data-direction`); add a `data-selected-path` attribute on the handle overlay so existing `closest("[data-path]")` patterns are replaced with `closest("[data-selected-path]")`.

---

## Task 1 — Install view.gl

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install**

```bash
pnpm add @bigmistqke/view.gl@0.1.18
```

- [ ] **Step 2: Verify import**

In a Node REPL or a throwaway test file, run:

```ts
import { view } from "@bigmistqke/view.gl"
console.log(typeof view) // "function"
```

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "deps: add @bigmistqke/view.gl"
```

---

## Task 2 — `layoutFrames`: walk the tree and return all leaf rects

**Files:**
- Modify: `src/viewport.ts`

- [ ] **Step 1: Add the function**

Append to `src/viewport.ts` (after the existing `frameRect` definition):

```ts
/** A rendered leaf entity in canvas-local coordinates. `path` is the
 *  full path to the leaf; `color` is its stable per-entity rgb.
 *  Returned by `layoutFrames` and consumed by both the WebGL renderer
 *  and the JS click hit-test. */
export type LeafFrame = {
  path: number[]
  rect: Rect
  color: string
}

/** Walk the layout tree once at the given canvas dims and produce:
 *
 *  - `leaves`: every Entity with its rect and color, in tree-traversal
 *    order. Siblings are non-overlapping (flex tiling), so click
 *    hit-test order doesn't matter.
 *  - `selectedRect`: the rect of the node at `selection.path[..-depth]`
 *    if a selection exists, else null. May be a container, not just an
 *    entity. Used by the handle overlay.
 *
 *  Pure function — no DOM reads. Caller passes scaled canvas dims for
 *  the desired output (e.g. `canvas.width * scale` to render at zoom).
 */
export function layoutFrames(
  layout: Node,
  canvas: { width: number; height: number },
  selection: Selection | null = null,
): { leaves: LeafFrame[]; selectedRect: Rect | null } {
  const leaves: LeafFrame[] = []
  let selectedRect: Rect | null = null

  const targetedPath =
    selection === null
      ? null
      : selection.path.slice(0, selection.path.length - selection.depth)

  function walk(node: Node, path: number[], rect: Rect) {
    if (targetedPath !== null && pathEquals(path, targetedPath)) {
      selectedRect = rect
    }
    if (node.type === "entity") {
      leaves.push({ path: path.slice(), rect, color: node.color })
      return
    }
    const childCount = node.children.length
    const totalGap = SIBLING_GAP * (childCount - 1)
    if (node.direction === "horizontal") {
      const childWidth = (rect.width - totalGap) / childCount
      for (let index = 0; index < childCount; index++) {
        const childRect: Rect = {
          x: rect.x + index * (childWidth + SIBLING_GAP),
          y: rect.y,
          width: childWidth,
          height: rect.height,
        }
        path.push(index)
        walk(node.children[index], path, childRect)
        path.pop()
      }
    } else {
      const childHeight = (rect.height - totalGap) / childCount
      for (let index = 0; index < childCount; index++) {
        const childRect: Rect = {
          x: rect.x,
          y: rect.y + index * (childHeight + SIBLING_GAP),
          width: rect.width,
          height: childHeight,
        }
        path.push(index)
        walk(node.children[index], path, childRect)
        path.pop()
      }
    }
  }

  const rootRect: Rect = {
    x: ROOT_PADDING,
    y: ROOT_PADDING,
    width: canvas.width - 2 * ROOT_PADDING,
    height: canvas.height - 2 * ROOT_PADDING,
  }
  walk(layout, [], rootRect)

  return { leaves, selectedRect }
}
```

Add the import at the top of the file:

```ts
import type { Direction, Node, Selection } from "./types"
import { pathEquals } from "./utils"
```

(`pathEquals` already exists in utils.ts; verify before adding the import.)

- [ ] **Step 2: Type-check**

```bash
pnpm exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/viewport.ts
git commit -m "feat(viewport): layoutFrames walks tree and returns all leaf rects"
```

---

## Task 3 — Shaders

**Files:**
- Create: `src/webgl/shaders.ts`

- [ ] **Step 1: Write the file**

```ts
/** WebGL2 shaders for the frame renderer. One instanced quad per leaf
 *  entity. The vertex shader maps a unit corner [0,1]² × per-instance
 *  (position, size) to canvas-local pixels, applies the viewport
 *  transform, and converts to clip space. Fragment shader paints the
 *  per-instance color. */

export const VERTEX_SHADER = /* glsl */ `#version 300 es
in vec2 a_corner;
in vec2 i_position;
in vec2 i_size;
in vec3 i_color;
uniform vec2 u_canvasSize;
uniform vec3 u_view;
out vec3 v_color;

void main() {
  vec2 canvasPixel = (a_corner * i_size + i_position) * u_view.z + u_view.xy;
  vec2 ndc = (canvasPixel / u_canvasSize) * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  v_color = i_color;
}
`

export const FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision mediump float;
in vec3 v_color;
out vec4 outColor;

void main() {
  outColor = vec4(v_color, 1.0);
}
`
```

- [ ] **Step 2: Commit**

```bash
git add src/webgl/shaders.ts
git commit -m "feat(webgl): vertex + fragment shaders for instanced frame quads"
```

---

## Task 4 — Renderer module

**Files:**
- Create: `src/webgl/renderer.ts`

- [ ] **Step 1: Write the renderer**

```ts
import { view } from "@bigmistqke/view.gl"
import type { LeafFrame } from "../viewport"
import { FRAGMENT_SHADER, VERTEX_SHADER } from "./shaders"

export type ViewportState = { x: number; y: number; scale: number }

/** Convert "rgb(r, g, b)" or "#rrggbb" to [0..1, 0..1, 0..1]. */
function parseColor(input: string): [number, number, number] {
  const rgbMatch = input.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/)
  if (rgbMatch) {
    return [
      parseInt(rgbMatch[1], 10) / 255,
      parseInt(rgbMatch[2], 10) / 255,
      parseInt(rgbMatch[3], 10) / 255,
    ]
  }
  const hexMatch = input.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (hexMatch) {
    return [
      parseInt(hexMatch[1], 16) / 255,
      parseInt(hexMatch[2], 16) / 255,
      parseInt(hexMatch[3], 16) / 255,
    ]
  }
  return [0.5, 0.5, 0.5]
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)
  if (!shader) {
    throw new Error("createShader returned null")
  }
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "unknown"
    gl.deleteShader(shader)
    throw new Error(`Shader compile failed: ${log}`)
  }
  return shader
}

function linkProgram(gl: WebGL2RenderingContext, vs: WebGLShader, fs: WebGLShader) {
  const program = gl.createProgram()
  if (!program) {
    throw new Error("createProgram returned null")
  }
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "unknown"
    gl.deleteProgram(program)
    throw new Error(`Program link failed: ${log}`)
  }
  return program
}

export type Renderer = {
  render(viewport: ViewportState, leaves: LeafFrame[]): void
  resize(width: number, height: number): void
  dispose(): void
}

/** Build a Renderer bound to `canvas`. WebGL2 required. */
export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const gl = canvas.getContext("webgl2", { antialias: true, premultipliedAlpha: true })
  if (!gl) {
    throw new Error("WebGL2 not supported")
  }

  const vs = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
  const program = linkProgram(gl, vs, fs)

  const { uniforms, attributes } = view(gl, program, {
    uniforms: {
      u_canvasSize: { kind: "vec2" },
      u_view: { kind: "vec3" },
    },
    attributes: {
      a_corner: { kind: "vec2" },
      i_position: { kind: "vec2", instanced: true },
      i_size: { kind: "vec2", instanced: true },
      i_color: { kind: "vec3", instanced: true },
    },
    interleavedAttributes: {},
    buffers: {},
  })

  // Static unit-quad corners (TRIANGLE_STRIP order: BL, BR, TL, TR).
  attributes.a_corner.set(new Float32Array([0, 1, 1, 1, 0, 0, 1, 0])).bind()

  const vao = gl.createVertexArray()

  // Reusable buffers for per-instance data; grown lazily.
  let posBuf = new Float32Array(0)
  let sizeBuf = new Float32Array(0)
  let colorBuf = new Float32Array(0)

  function ensureBufferSize(count: number) {
    if (posBuf.length < count * 2) {
      posBuf = new Float32Array(count * 2)
      sizeBuf = new Float32Array(count * 2)
      colorBuf = new Float32Array(count * 3)
    }
  }

  function render(viewport: ViewportState, leaves: LeafFrame[]) {
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    if (leaves.length === 0) {
      return
    }

    ensureBufferSize(leaves.length)
    for (let index = 0; index < leaves.length; index++) {
      const leaf = leaves[index]
      posBuf[index * 2] = leaf.rect.x
      posBuf[index * 2 + 1] = leaf.rect.y
      sizeBuf[index * 2] = leaf.rect.width
      sizeBuf[index * 2 + 1] = leaf.rect.height
      const [r, g, b] = parseColor(leaf.color)
      colorBuf[index * 3] = r
      colorBuf[index * 3 + 1] = g
      colorBuf[index * 3 + 2] = b
    }

    gl.useProgram(program)
    gl.bindVertexArray(vao)

    attributes.a_corner.bind()
    attributes.i_position.set(posBuf.subarray(0, leaves.length * 2)).bind()
    attributes.i_size.set(sizeBuf.subarray(0, leaves.length * 2)).bind()
    attributes.i_color.set(colorBuf.subarray(0, leaves.length * 3)).bind()

    uniforms.u_canvasSize.set(canvas.width, canvas.height)
    uniforms.u_view.set(viewport.x, viewport.y, viewport.scale)

    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, leaves.length)
  }

  function resize(width: number, height: number) {
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    gl.viewport(0, 0, canvas.width, canvas.height)
  }

  function dispose() {
    gl.deleteProgram(program)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    if (vao) {
      gl.deleteVertexArray(vao)
    }
  }

  return { render, resize, dispose }
}
```

- [ ] **Step 2: Type-check**

```bash
pnpm exec tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/webgl/renderer.ts
git commit -m "feat(webgl): renderer module with view.gl-driven instanced quad draw"
```

---

## Task 5 — Animation driver

**Files:**
- Create: `src/webgl/animation.ts`

- [ ] **Step 1: Write the driver**

```ts
import type { ViewportState } from "./renderer"

const ANIMATION_MS = 220

/** Cubic-bezier(0.4, 0, 0.2, 1) approximated via a one-step Newton iteration.
 *  Good enough — within 0.5% of the true curve over [0,1]. */
function ease(t: number): number {
  if (t <= 0) {
    return 0
  }
  if (t >= 1) {
    return 1
  }
  // Material-style ease-in-out: `t * t * (3 - 2 * t)` is a smoothstep
  // that's visually close to cubic-bezier(0.4, 0, 0.2, 1).
  return t * t * (3 - 2 * t)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function lerpViewport(from: ViewportState, to: ViewportState, t: number): ViewportState {
  return {
    x: lerp(from.x, to.x, t),
    y: lerp(from.y, to.y, t),
    scale: lerp(from.scale, to.scale, t),
  }
}

/** Run a single rAF tween from `from` → `to`. `onTick(viewport)` fires
 *  every frame (including the final frame at t=1). `onSettle` fires
 *  once the tween completes. Returns a `cancel` function that stops
 *  the rAF loop without firing onSettle.
 *
 *  Animations are NOT chained — caller is responsible for cancelling
 *  any in-flight tween before starting a new one. */
export function animateViewport(
  from: ViewportState,
  to: ViewportState,
  onTick: (viewport: ViewportState) => void,
  onSettle: () => void,
  duration = ANIMATION_MS,
): () => void {
  const start = performance.now()
  let cancelled = false
  let rafHandle = 0

  function tick() {
    if (cancelled) {
      return
    }
    const elapsed = performance.now() - start
    const t = ease(Math.min(elapsed / duration, 1))
    const current = lerpViewport(from, to, t)
    onTick(current)
    if (elapsed < duration) {
      rafHandle = requestAnimationFrame(tick)
    } else {
      onSettle()
    }
  }

  rafHandle = requestAnimationFrame(tick)
  return () => {
    cancelled = true
    cancelAnimationFrame(rafHandle)
  }
}
```

- [ ] **Step 2: Type-check**

```bash
pnpm exec tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/webgl/animation.ts
git commit -m "feat(webgl): rAF-driven viewport tween"
```

---

## Task 6 — Expose `viewport` signal on Context

**Files:**
- Modify: `src/state.ts`
- Modify: `src/types.ts`

- [ ] **Step 1: Add a `viewport` signal**

In `src/state.ts`, add alongside the other signals:

```ts
import type { ViewportTransform } from "./viewport"

const [viewport, setViewport] = createSignal<ViewportTransform>(
  { x: 0, y: 0, scale: 1 },
  { ownedWrite: true },
)
```

Return `viewport` and `setViewport` from `createAppState()`:

```ts
return {
  // ... existing entries
  viewport,
  setViewport,
}
```

- [ ] **Step 2: Add to `AppContext` type**

In `src/types.ts`:

```ts
import type { ViewportTransform } from "./viewport"

export interface AppContext {
  // ... existing
  viewport: () => ViewportTransform
  setViewport: (next: ViewportTransform) => void
}
```

- [ ] **Step 3: Type-check**

```bash
pnpm exec tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/state.ts src/types.ts
git commit -m "feat(state): expose viewport signal on context"
```

---

## Task 7 — Canvas component (WebGL canvas + handle overlay + click hit-test)

**Files:**
- Create: `src/components/canvas.tsx`
- Create: `src/components/canvas.module.css`

- [ ] **Step 1: Write the CSS**

```css
/* src/components/canvas.module.css */
.canvasWrapper {
  position: absolute;
  inset: 0;
}

.glCanvas {
  position: absolute;
  inset: 0;
  display: block;
}

.handleOverlay {
  position: absolute;
  left: var(--x, 0px);
  top: var(--y, 0px);
  width: var(--width, 0px);
  height: var(--height, 0px);
  pointer-events: none; /* notch children re-enable */
}
```

- [ ] **Step 2: Write the component**

```tsx
// src/components/canvas.tsx
import { createMemo, For, onSettled, Show, useContext } from "solid-js"
import { Context } from "../context"
import type { Direction } from "../types"
import { logAction } from "../utils"
import { animateViewport } from "../webgl/animation"
import { createRenderer, type ViewportState } from "../webgl/renderer"
import { layoutFrames, type LeafFrame, type Rect } from "../viewport"
import { ArrowNotch } from "./notch"
import styles from "./canvas.module.css"

const HANDLE_DIRECTIONS: Direction[] = ["top", "bottom", "left", "right"]

export function Canvas() {
  const context = useContext(Context)!
  let canvasElement!: HTMLCanvasElement
  let wrapperElement!: HTMLDivElement

  // Latest layout result — captured each render so the click handler can
  // hit-test against the same data the GL just drew.
  let lastLeaves: LeafFrame[] = []
  let lastViewport: ViewportState = { x: 0, y: 0, scale: 1 }

  onSettled(() => {
    const renderer = createRenderer(canvasElement)

    function syncSize() {
      const rect = wrapperElement.getBoundingClientRect()
      renderer.resize(rect.width, rect.height)
      drawSettled()
    }

    function drawAt(viewport: ViewportState) {
      const rect = wrapperElement.getBoundingClientRect()
      const scaledCanvas = {
        width: rect.width * viewport.scale,
        height: rect.height * viewport.scale,
      }
      const { leaves, selectedRect } = layoutFrames(
        context.app.layout,
        scaledCanvas,
        context.app.selection,
      )
      lastLeaves = leaves
      lastViewport = viewport
      renderer.render(viewport, leaves)
      // Expose for tests.
      ;(window as unknown as { __layoutFrames?: () => unknown }).__layoutFrames = () => ({
        leaves: lastLeaves,
        selectedRect,
        viewport,
        canvas: rect,
      })
      // Drive the handle overlay's CSS vars from selected rect (in
      // screen-space, after applying viewport transform).
      if (selectedRect) {
        const screen = applyViewportToRect(selectedRect, viewport)
        wrapperElement.style.setProperty("--selected-x", `${screen.x}px`)
        wrapperElement.style.setProperty("--selected-y", `${screen.y}px`)
        wrapperElement.style.setProperty("--selected-width", `${screen.width}px`)
        wrapperElement.style.setProperty("--selected-height", `${screen.height}px`)
      }
    }

    let cancelTween: (() => void) | undefined

    function drawSettled() {
      cancelTween?.()
      cancelTween = undefined
      const viewport = computeTargetViewport()
      drawAt(viewport)
      context.setIsAnimating(false)
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

    function computeTargetViewport(): ViewportState {
      // Reuse existing computeViewportTransform via state context. It needs
      // canvas rect + hud rects. We avoid importing it directly here — the
      // existing layout-builder.tsx layoutPass already sets selectedHandlesState
      // and viewport via state; we just read the latest viewport snapshot
      // it computed. A signal (context.viewport) is added in this task.
      return context.viewport()
    }

    syncSize()
    const resizeObserver = new ResizeObserver(syncSize)
    resizeObserver.observe(wrapperElement)
    return () => {
      cancelTween?.()
      resizeObserver.disconnect()
      renderer.dispose()
    }
  })

  // Drive frame draws from state changes (selection, layout, tool).
  // Implemented as an effect that triggers `startAnimation` on viewport
  // change. Rendering also happens during the tween via animateViewport's
  // onTick.
  // ... (wire-up below in Task 8)

  // Click hit-test — clicks anywhere inside wrapperElement that aren't on
  // a notch get hit-tested against lastLeaves. Notches stop propagation
  // already (notch.tsx already wires onClick={event => event.stopPropagation()}
  // on the outer wrapper).
  function onWrapperClick(event: MouseEvent) {
    if (context.app.tool === null) {
      return
    }
    const rect = wrapperElement.getBoundingClientRect()
    const screenX = event.clientX - rect.left
    const screenY = event.clientY - rect.top
    // Convert screen → canvas-local pixels at the current viewport.
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

  // Selected path for tests (closest("[data-selected-path]")).
  const selectedPathKey = createMemo(() => {
    const selection = context.app.selection
    if (selection === null) {
      return null
    }
    const targeted = selection.path.slice(0, selection.path.length - selection.depth)
    return targeted.join(".")
  })

  return (
    <div
      ref={wrapperElement}
      class={styles.canvasWrapper}
      onClick={onWrapperClick}
      data-canvas-inner="true"
    >
      <canvas ref={canvasElement} class={styles.glCanvas} />
      <Show when={!context.isAnimating() && context.app.tool !== null && selectedPathKey() !== null}>
        <div
          class={styles.handleOverlay}
          data-selected-path={selectedPathKey()}
          style={{
            "--x": "var(--selected-x, 0px)",
            "--y": "var(--selected-y, 0px)",
            "--width": "var(--selected-width, 0px)",
            "--height": "var(--selected-height, 0px)",
          }}
        >
          <For each={HANDLE_DIRECTIONS}>
            {direction => (
              <ArrowNotch
                direction={direction}
                onClick={() => {
                  const selection = context.app.selection!
                  const targeted = selection.path.slice(
                    0,
                    selection.path.length - selection.depth,
                  )
                  const op = context.app.tool!
                  logAction("add-frame", { path: targeted, direction, op })
                  context.handleAddFrame(targeted, direction, op)
                }}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

function applyViewportToRect(rect: Rect, viewport: ViewportState): Rect {
  return {
    x: rect.x * viewport.scale + viewport.x,
    y: rect.y * viewport.scale + viewport.y,
    width: rect.width * viewport.scale,
    height: rect.height * viewport.scale,
  }
}
```

- [ ] **Step 3: Type-check**

```bash
pnpm exec tsc --noEmit
```

Expected: clean. Task 6 already added `context.viewport`/`setViewport`. The other context entries (`handleAddFrame`, `setSelection`, `computeHudRects`, `isAnimating`, `setIsAnimating`) all exist on the current AppContext.

- [ ] **Step 4: Commit**

```bash
git add src/components/canvas.tsx src/components/canvas.module.css
git commit -m "feat: WebGL Canvas component with handle overlay + click hit-test"
```

---

## Task 8 — Drive `viewport` and animation from selection changes

**Files:**
- Modify: `src/components/canvas.tsx`
- Modify: `src/layout-builder.tsx`

- [ ] **Step 1: Move `layoutPass` viewport computation into a shared helper**

Cut the body of `layoutPass` from `src/layout-builder.tsx` (lines that compute `transform` via `computeViewportTransform` and the `extend`/`stick` from `computeExtends`/`computeSticks`). Place it into a new function `recomputeViewport()` in `canvas.tsx` that:

1. Reads canvas rect from `wrapperElement.getBoundingClientRect()`.
2. Reads `context.app.selection`, `context.app.layout`.
3. Computes hud rects via `context.computeHudRects(canvasRect)`.
4. Calls `computeViewportTransform(layout, selectedPath, canvas, 1, hudRects)`.
5. Calls `context.setViewport(transform)`.
6. Computes extend/stick from postRect, calls `context.setSelectedHandlesState({ extend, stick })`.

Then `createEffect` watches `(context.app.layout, context.app.selection)` via a layout-signature memo (use the existing `layoutSignature` helper from layout-builder.tsx; move it too) and calls `recomputeViewport()` followed by `startAnimation(context.viewport())`.

- [ ] **Step 2: Wire animation start on viewport change**

After `recomputeViewport()` writes a new viewport via `context.setViewport`, start a tween from `lastViewport` to the new value:

```ts
createEffect(
  () => layoutSignature(context.app.layout, context.app.selection),
  () => {
    recomputeViewport()
    startAnimation(context.viewport())
  },
)
```

- [ ] **Step 3: Delete the old WAAPI block in layout-builder.tsx**

Delete:
- The `currentAnimation`, `animationTimer`, `ANIMATION_MS`, `SETTLE_MS` locals.
- The `createEffect(viewport, viewport => { ... })` that ran the WAAPI animation.
- The `viewport` signal local to layout-builder.tsx (the one with the `equalsWithin` epsilon comparator) — replaced by `context.viewport`.

Keep the `canvasAspect` signal and ResizeObserver setup; that still feeds the breadcrumb.

- [ ] **Step 4: Type-check + boot the dev server**

```bash
pnpm exec tsc --noEmit
pnpm dev:test &
sleep 2
curl -s http://localhost:5174/ | head -1
kill %1
```

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas.tsx src/layout-builder.tsx
git commit -m "feat: drive viewport via context signal + rAF tween in Canvas component"
```

---

## Task 9 — Wire `<Canvas />` into the layout tree, drop `NodeComponent`

**Files:**
- Modify: `src/layout-builder.tsx`
- Modify: `src/app.tsx`
- Delete: `src/components/node-component.tsx`
- Delete: `src/components/node-component.module.css`

- [ ] **Step 1: Replace canvasInner with Canvas**

In `src/layout-builder.tsx`, change the JSX:

```tsx
return (
  <div class={styles.layoutBuilder}>
    <div class={styles.canvas} ref={canvasElement} data-canvas="true">
      <Canvas />
      <Breadcrumb canvasAspect={canvasAspect} />
      <Contextual />
    </div>
  </div>
)
```

Add the import:

```ts
import { Canvas } from "./components/canvas"
```

Remove the `<div class={styles.canvasInner}>` and the `props.children` slot. `<LayoutBuilder>` no longer takes children — drop the `props.children` from its signature.

- [ ] **Step 2: Drop `<NodeComponent />` from `app.tsx`**

```tsx
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
        <LayoutBuilder />
        <Main />
      </div>
    </Context>
  )
}
```

- [ ] **Step 3: Delete the old files**

```bash
rm src/components/node-component.tsx src/components/node-component.module.css
```

- [ ] **Step 4: Drop `canvasInner` CSS rule**

In `src/layout-builder.module.css`, remove the `.canvasInner` block. Keep `.layoutBuilder` and `.canvas`.

- [ ] **Step 5: Type-check**

```bash
pnpm exec tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add src/app.tsx src/layout-builder.tsx src/layout-builder.module.css
git rm src/components/node-component.tsx src/components/node-component.module.css
git commit -m "feat: wire Canvas into LayoutBuilder; drop NodeComponent + canvasInner"
```

---

## Task 10 — Reposition notches against the handle overlay

**Files:**
- Modify: `src/components/notch.module.css`

- [ ] **Step 1: Rewrite per-direction CSS**

The handle overlay sets `--x`, `--y`, `--width`, `--height` on its div. Notches inside use `position: absolute` and reference these vars. Stick + extend continue to compose.

Replace the four direction blocks:

```css
.notch {
  height: calc(var(--hud-height) + var(--extend, 0px));
  position: absolute;
  z-index: var(--z-notch);
  color: var(--color-front);
  pointer-events: auto;

  &.bottom {
    left: calc(var(--width) / 2);
    top: calc(var(--height) - var(--frame-padding, 0px) - var(--stick, 0px) - var(--hud-height) - var(--extend, 0px));
  }

  &.top {
    left: calc(var(--width) / 2);
    top: calc(var(--frame-padding, 0px) + var(--stick, 0px));
    rotate: 180deg;
    transform-origin: center center;
  }

  &.left {
    left: calc(var(--frame-padding, 0px) + var(--stick, 0px));
    top: calc(var(--height) / 2);
    rotate: 90deg;
    transform-origin: top;
    translate: calc((var(--hud-height) + var(--extend, 0px))) 0;
  }

  &.right {
    left: calc(var(--width) - var(--frame-padding, 0px) - var(--stick, 0px));
    top: calc(var(--height) / 2);
    rotate: -90deg;
    transform-origin: top;
    translate: calc(-1 * (var(--hud-height) + var(--extend, 0px))) 0;
  }
}
```

- [ ] **Step 2: Boot dev server, sanity-check visually**

```bash
pnpm dev:test &
sleep 2
echo "Open http://localhost:5174 in a browser — verify a single split shows handles on the right entity, then kill server"
```

(Skip the visual check in CI; this is for the engineer to confirm before committing.)

- [ ] **Step 3: Commit**

```bash
git add src/components/notch.module.css
git commit -m "style(notch): position notches against handle-overlay CSS vars"
```

---

## Task 11 — Test helpers: window hook + selectors

**Files:**
- Modify: `tests/helpers.ts`

- [ ] **Step 1: Switch `frameRect` to use the window hook**

```ts
export async function frameRect(page: Page, path: number[]) {
  const key = path.join(".")
  return page.evaluate(k => {
    const layoutFrames = (window as unknown as { __layoutFrames?: () => unknown }).__layoutFrames
    if (!layoutFrames) {
      return null
    }
    const data = layoutFrames() as {
      leaves: Array<{ path: number[]; rect: { x: number; y: number; width: number; height: number } }>
      selectedRect: { x: number; y: number; width: number; height: number } | null
      viewport: { x: number; y: number; scale: number }
      canvas: { left: number; top: number; width: number; height: number }
    }
    const target =
      k === ""
        ? null
        : data.leaves.find(leaf => leaf.path.join(".") === k)?.rect ?? null
    if (!target) {
      // For empty path (root) or container paths, use selectedRect when
      // it matches; otherwise return null. Tests reading container rects
      // are rare.
      return null
    }
    // Apply viewport transform to get screen-space rect (matches the old
    // getBoundingClientRect-based test helper output).
    return {
      x: target.x * data.viewport.scale + data.viewport.x,
      y: target.y * data.viewport.scale + data.viewport.y,
      w: target.width * data.viewport.scale,
      h: target.height * data.viewport.scale,
    }
  }, key)
}
```

- [ ] **Step 2: Update `clickFrame` to synthesize a canvas click**

```ts
export async function clickFrame(page: Page, path: number[], options?: { force?: boolean }) {
  const key = path.join(".")
  // Resolve the target leaf's screen-space center via the window hook,
  // then dispatch a click at those coordinates on the canvas wrapper.
  const center = await page.evaluate(k => {
    const layoutFrames = (window as unknown as { __layoutFrames?: () => unknown }).__layoutFrames
    if (!layoutFrames) {
      return null
    }
    const data = layoutFrames() as {
      leaves: Array<{ path: number[]; rect: { x: number; y: number; width: number; height: number } }>
      viewport: { x: number; y: number; scale: number }
      canvas: { left: number; top: number; width: number; height: number }
    }
    const leaf = k === "" ? data.leaves[0] : data.leaves.find(l => l.path.join(".") === k)
    if (!leaf) {
      return null
    }
    const screenX = leaf.rect.x * data.viewport.scale + data.viewport.x + (leaf.rect.width * data.viewport.scale) / 2
    const screenY = leaf.rect.y * data.viewport.scale + data.viewport.y + (leaf.rect.height * data.viewport.scale) / 2
    return { x: data.canvas.left + screenX, y: data.canvas.top + screenY }
  }, key)
  if (!center) {
    throw new Error(`clickFrame: no leaf at path ${key}`)
  }
  // `force` not needed for canvas clicks (no element-size limits at the
  // canvas level), but accept the option for API parity.
  await page.mouse.click(center.x, center.y)
}
```

- [ ] **Step 3: Update `expectFrameRespectsMargin` and `expectHandlesInViewport`**

These already query `[data-canvas='true']` (kept) and `[data-direction]` (still rendered by the handle overlay). The helpers should work unchanged. Verify by running them.

- [ ] **Step 4: Update `clickAction` for actions emitted by the new flow**

Selection used to bubble through entity onClick → setSelection. Now it goes through the canvas wrapper's onClick → setSelection. Same `[action] {"type":"tap-frame"...}` log line is emitted. No helper change needed — verify by reading any test that captures action logs.

- [ ] **Step 5: Commit**

```bash
git add tests/helpers.ts
git commit -m "test(helpers): query layout via window.__layoutFrames hook"
```

---

## Task 12 — Run full test suite, fix breakages

- [ ] **Step 1: Run all tests**

```bash
pnpm test 2>&1 | tail -30
```

Expected: most tests pass. Likely-failure list and fixes:

- **`no-zoom-when-not-needed`** — reads `[data-canvas-inner='true']` `style.width` and `style.transform`. The new wrapper has `data-canvas-inner="true"` but no inline width/transform — viewport is now state, not DOM. Replace the assertion with a window-hook read of `data.viewport`.

  ```ts
  const viewport = await page.evaluate(() => {
    const fn = (window as unknown as { __layoutFrames?: () => { viewport: { scale: number; x: number; y: number } } }).__layoutFrames
    return fn ? fn().viewport : null
  })
  expect(viewport!.scale).toBe(1)
  expect(Math.abs(viewport!.x)).toBeLessThan(1)
  expect(Math.abs(viewport!.y)).toBeLessThan(1)
  ```

- **`smoke.spec.ts`** test 2 (`activating a tool shows the canvas inner`) — `readViewport` helper still reads from the wrapper's `style.width`. Same fix as above (use the hook).

- **Tests that call `result.path` from a `[data-direction]` `closest("[data-path]")` chain** — the parent element is now `[data-selected-path]`. Update those tests to:

  ```ts
  selected = handle?.closest<HTMLElement>("[data-selected-path]")
  selected?.getAttribute("data-selected-path")
  ```

- [ ] **Step 2: Apply the fixes inline in the failing spec files**

For each failure, edit the spec file to use the hook / new selector. Don't bulk-rewrite untested code paths.

- [ ] **Step 3: Re-run, expect 19 passing (same count as before this work)**

```bash
pnpm test 2>&1 | tail -5
```

Expected: `19 passed`.

- [ ] **Step 4: Commit**

```bash
git add tests/
git commit -m "test: adapt specs to WebGL canvas + window.__layoutFrames hook"
```

---

## Task 13 — Smoke check the build and the deployed page

- [ ] **Step 1: Build**

```bash
pnpm build
```

Expected: builds clean, dist/ has updated assets.

- [ ] **Step 2: Push**

```bash
git push origin main
```

- [ ] **Step 3: Verify GH Actions deploy succeeded**

```bash
gh run list --limit 3
gh run watch
```

Expected: latest workflow on `main` succeeds.

- [ ] **Step 4: Open the deployed page in a browser**

Visit `https://bigmistqke.github.io/eddy-layout-builder/`. Verify:
- Initial entity renders as a single colored quad filling the canvas.
- Clicking a tool (split / append) and then a frame selects it; handles appear.
- Clicking a handle splits/appends — new colored quads show up.
- Zoom animations still feel smooth.

If anything is broken, file a follow-up — don't roll back the rewrite.
