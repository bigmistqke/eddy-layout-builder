# Centralized Layout Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-frame collision math with a single `layoutPass()` driver that decides viewport scale, translation, and per-direction extends/sticks for the selected frame from one analytical geometry snapshot.

**Architecture:** Frame rects come from a pure tree-walk function (`frameRect`) over `app.layout`, not from DOM measurements. `layoutPass` in `layout-builder.tsx` orchestrates: read inputs (selection, layout, canvas size, HUD insets), compute viewport via `computeViewportTransform`, derive post-transform rect, compute extends/sticks analytically, set two output signals (`viewport`, `selectedHandlesState`). Frame becomes view-only; the collision registry is deleted.

**Tech Stack:** Solid 2.x (`solid-js`, `@solidjs/signals`, `@solidjs/web`), TypeScript, CSS Modules, Vite.

**Verification:** No test framework is configured. Each task is verified by `npm run typecheck` and visual UAT in the dev server (`npm run dev`).

**Spec:** `docs/superpowers/specs/2026-05-06-centralized-layout-pass-design.md`

---

## File map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/ui-constants.ts` | Modify | Single source for HANDLE_*, ROOT_PADDING, SIBLING_GAP |
| `src/viewport.ts` | Modify | Add `frameRect`, `applyTransform`, `computeExtends`, `computeSticks`. Refactor `computeViewportTransform` to take `baseRect` directly |
| `src/types.ts` | Modify | Add `selectedHandlesState`/`setSelectedHandlesState` to `AppContext`. Remove `canvasEl`, `setCanvasEl`, collision-registry members |
| `src/app.tsx` | Modify | Initialize `selectedHandlesState`; remove collision registry, `canvasEl` signal, `frameCallbacks` plumbing |
| `src/layout-builder.tsx` | Modify | Implement `layoutPass`; own a local canvas `ResizeObserver`; subscribe to selection + `app.layout` |
| `src/frame.tsx` | Modify | Reduce to view-only; read `selectedHandlesState` from context |
| `src/collision.ts` | Delete | Used only by collision registry |

---

## Task 1: Consolidate constants in ui-constants.ts

**Files:**
- Modify: `src/ui-constants.ts`
- Modify: `src/viewport.ts`

- [ ] **Step 1: Replace contents of `src/ui-constants.ts`**

```ts
// Handle dimensions in CSS pixels — mirror frame.module.css notch geometry.
// Top/bottom handles are HANDLE_W wide × HANDLE_H tall, centered on the
// frame's top/bottom edge. Left/right handles are 90° rotated, so they
// occupy HANDLE_H × HANDLE_W centered on the frame's left/right edge.
export const HANDLE_W = 100
export const HANDLE_H = 60

// Buffer added to handle-fit minimums so frames are slightly bigger than
// the strict minimum — avoids floating-point drift flipping rectsOverlap
// from "touch" (no overlap) to "0.0001px overlap" at the boundary.
export const HANDLE_BUFFER = 20

// Same-axis pair (top vs bottom or left vs right) requires both notches
// HANDLE_H tall to fit non-overlapping along the axis.
export const SAME_AXIS_MIN = 2 * HANDLE_H + HANDLE_BUFFER

// Corner pairs (top vs left, etc.): top handle's horizontal range is
// [c − HANDLE_W/2, c + HANDLE_W/2]; rotated left handle's horizontal
// range is [0, HANDLE_H]. For non-overlap, frame must satisfy
// width ≥ HANDLE_W + 2·HANDLE_H (or the same on height).
export const CROSS_PAIR_MIN = HANDLE_W + 2 * HANDLE_H + HANDLE_BUFFER

// Layout — must stay in sync with --padding in index.css and the
// .layoutContainerRoot/.layoutContainer rules in app.module.css.
// Root container has padding on all sides plus gap between children.
// Non-root containers have only gap.
export const ROOT_PADDING = 4
export const SIBLING_GAP = 4
```

- [ ] **Step 2: Update viewport.ts to import from ui-constants**

In `src/viewport.ts`, find the constants block at the top (lines 7-27 in the current file) and replace:

```ts
const HANDLE_W = 100
const HANDLE_H = 60

// ... long comment ...

const HANDLE_BUFFER = 20
const SAME_AXIS_MIN = 2 * HANDLE_H + HANDLE_BUFFER
const CROSS_PAIR_MIN = HANDLE_W + 2 * HANDLE_H + HANDLE_BUFFER
```

with a single import line at the top of the file (added after the existing imports):

```ts
import { HANDLE_H, HANDLE_W, HANDLE_BUFFER, SAME_AXIS_MIN, CROSS_PAIR_MIN } from "./ui-constants"
```

(The leading `import type { Selection }` line stays.)

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/ui-constants.ts src/viewport.ts
git commit -m "refactor: consolidate handle/layout constants in ui-constants.ts"
```

---

## Task 2: Add pure layout primitives to viewport.ts

**Files:**
- Modify: `src/viewport.ts`

This task adds new exported functions without changing any existing behavior. Existing `computeViewportTransform` keeps its current signature; Task 3 refactors it to use these primitives.

- [ ] **Step 1: Update imports in viewport.ts**

In `src/viewport.ts`, at the top, replace:

```ts
import type { Selection } from "./types"
```

with:

```ts
import { HANDLE_H, HANDLE_W, HANDLE_BUFFER, SAME_AXIS_MIN, CROSS_PAIR_MIN, ROOT_PADDING, SIBLING_GAP } from "./ui-constants"
import type { Container, Direction, Node, Selection } from "./types"
```

- [ ] **Step 2: Add pure rect type and frameRect function**

Append to `src/viewport.ts` (after `transformToCss` at the bottom):

```ts
/** Axis-aligned rect in canvas-local coordinates. Coordinates are in CSS
 *  pixels of the un-zoomed canvas. */
export type Rect = { x: number; y: number; w: number; h: number }

/**
 * Compute a frame's rect from the layout tree and canvas dimensions.
 *
 * Mirrors the CSS flex layout: every container has `display: flex` with
 * children at `flex: 1`. The root container has padding on all sides plus
 * gap between children; non-root containers have only gap.
 *
 * Pure function — no DOM reads. Caller passes canvas dims and the path of
 * the target frame (empty path = root container).
 */
export function frameRect(
  layout: Container,
  path: number[],
  canvas: { w: number; h: number },
): Rect {
  // Root: canvas inset by ROOT_PADDING on all sides.
  let rect: Rect = {
    x: ROOT_PADDING,
    y: ROOT_PADDING,
    w: canvas.w - 2 * ROOT_PADDING,
    h: canvas.h - 2 * ROOT_PADDING,
  }
  let current: Node = layout
  for (const idx of path) {
    if (current.type !== "container") break
    const n = current.children.length
    const totalGap = SIBLING_GAP * (n - 1)
    if (current.direction === "horizontal") {
      const childW = (rect.w - totalGap) / n
      rect = {
        x: rect.x + idx * (childW + SIBLING_GAP),
        y: rect.y,
        w: childW,
        h: rect.h,
      }
    } else {
      const childH = (rect.h - totalGap) / n
      rect = {
        x: rect.x,
        y: rect.y + idx * (childH + SIBLING_GAP),
        w: rect.w,
        h: childH,
      }
    }
    current = current.children[idx]
  }
  return rect
}
```

- [ ] **Step 3: Add applyTransform**

Append to `src/viewport.ts`:

```ts
/** Apply scale + translation to a rect. The scale multiplies width/height
 *  and offsets x/y; the translation is added on top in canvas coords. */
export function applyTransform(
  rect: Rect,
  scale: number,
  translation: { x: number; y: number },
): Rect {
  return {
    x: rect.x * scale + translation.x,
    y: rect.y * scale + translation.y,
    w: rect.w * scale,
    h: rect.h * scale,
  }
}
```

- [ ] **Step 4: Add computeExtends**

Append to `src/viewport.ts`:

```ts
/** Per-direction extend amount (px) for a frame's handle notches against
 *  the HUDs on each canvas edge. Non-zero when the frame's edge is
 *  underneath the corresponding HUD's interior face. */
export function computeExtends(
  rect: Rect,
  canvas: { w: number; h: number },
  hudInsets: HudInsets,
): Record<Direction, number> {
  return {
    top: Math.max(0, hudInsets.top - rect.y),
    bottom: Math.max(0, rect.y + rect.h - (canvas.h - hudInsets.bottom)),
    left: Math.max(0, hudInsets.left - rect.x),
    right: Math.max(0, rect.x + rect.w - (canvas.w - hudInsets.right)),
  }
}
```

- [ ] **Step 5: Add computeSticks**

Append to `src/viewport.ts`:

```ts
/** Per-direction stick amount (px) — how far to pull each handle inward
 *  to keep it visible inside the canvas viewport. Non-zero when the frame
 *  extends past the canvas edge entirely. */
export function computeSticks(
  rect: Rect,
  canvas: { w: number; h: number },
): Record<Direction, number> {
  return {
    top: Math.max(0, -rect.y),
    bottom: Math.max(0, rect.y + rect.h - canvas.h),
    left: Math.max(0, -rect.x),
    right: Math.max(0, rect.x + rect.w - canvas.w),
  }
}
```

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/viewport.ts
git commit -m "feat(viewport): add pure layout primitives (frameRect, applyTransform, computeExtends, computeSticks)"
```

---

## Task 3: Refactor computeViewportTransform to take a base rect

**Files:**
- Modify: `src/viewport.ts`
- Modify: `src/layout-builder.tsx`

The current signature reads the DOM via `offsetRelativeToRoot`. Replace with a signature that accepts a pre-computed `baseRect`. The caller uses `frameRect` first.

- [ ] **Step 1: Replace computeViewportTransform in viewport.ts**

In `src/viewport.ts`, replace the entire `computeViewportTransform` function and the `offsetRelativeToRoot` helper (lines 51-114 in the current file) with:

```ts
/**
 * Compute the viewport transform for a selected frame's base rect.
 *
 * `currentScale`: the canvas's current size multiplier — used by callers
 * to decide minScale (when already zoomed, callers pass `currentScale`
 * here so the viewport never zooms *out* on tap; only the back button
 * does that). Note: `baseRect` is in un-zoomed coords already, so
 * `currentScale` is NOT used to recover dimensions here.
 *
 * `minScale`: minimum scale to apply regardless of handle-fit needs.
 *
 * `hudInsets`: how far each HUD intrudes from its canvas edge. Used to
 * decide whether the frame's natural position leaves room for handle
 * extends without same-axis-pair overlap. If natural is fine, identity
 * — preserves "no pan when not needed" UX. Otherwise the frame is
 * panned to the canvas's effective center (canvas minus HUD insets).
 */
export function computeViewportTransform(
  baseRect: Rect,
  canvas: { w: number; h: number },
  minScale = 1,
  hudInsets: HudInsets = NO_HUD_INSETS,
): ViewportTransform {
  if (baseRect.w === 0 || baseRect.h === 0) return IDENTITY_VIEWPORT

  const handleScale = Math.max(
    SAME_AXIS_MIN / baseRect.w,
    SAME_AXIS_MIN / baseRect.h,
    Math.min(CROSS_PAIR_MIN / baseRect.w, CROSS_PAIR_MIN / baseRect.h),
  )

  const scale = Math.max(handleScale, minScale)

  // Identity-eligible (no zoom needed) — but check whether the frame's
  // *natural* position has acceptable extends. If a HUD-induced extend
  // would push a same-axis handle pair into overlap, pan to effective
  // center; otherwise return identity.
  if (scale <= 1) {
    const naturalExt = computeExtends(baseRect, canvas, hudInsets)
    const verticalFits = baseRect.h >= SAME_AXIS_MIN + naturalExt.top + naturalExt.bottom
    const horizontalFits = baseRect.w >= SAME_AXIS_MIN + naturalExt.left + naturalExt.right
    if (verticalFits && horizontalFits) return IDENTITY_VIEWPORT
  }

  // Pan the frame's center to the canvas's *effective* center
  // (canvas minus HUD insets). This honors asymmetric HUDs — e.g., when
  // the right contextual toolbar is visible, effective center shifts left.
  const effectiveCx = (hudInsets.left + canvas.w - hudInsets.right) / 2
  const effectiveCy = (hudInsets.top + canvas.h - hudInsets.bottom) / 2
  const nodeCenterX = (baseRect.x + baseRect.w / 2) * scale
  const nodeCenterY = (baseRect.y + baseRect.h / 2) * scale
  const x = effectiveCx - nodeCenterX
  const y = effectiveCy - nodeCenterY
  return { scale, x, y }
}
```

This drops `offsetRelativeToRoot`, `node`, `layoutRoot`, and `currentScale`-as-base-recovery. The function is now pure.

- [ ] **Step 2: Update the call site in layout-builder.tsx**

In `src/layout-builder.tsx`, find the import line:

```ts
import {
  computeViewportTransform,
  IDENTITY_VIEWPORT,
  selectedPathKey,
  transformToCss,
} from "./viewport"
```

Update to:

```ts
import {
  computeViewportTransform,
  frameRect,
  IDENTITY_VIEWPORT,
  selectedPathKey,
  transformToCss,
} from "./viewport"
```

Then find the body of `recomputeViewport`:

```ts
const node = innerEl.querySelector<HTMLElement>(`[data-path="${key}"]`)
if (!node) return

// Always fit the new selection. The viewport signal's `equals` is
// epsilon-based — identity→identity is a no-op, sub-pixel drift from
// recomputing against settled geometry is also a no-op, but a real
// change (different selection, real resize) does propagate.
const prev = untrack(() => viewport())
const hudInsets = computeHudInsets(rect)
const t = computeViewportTransform(node, innerEl, baseW, baseH, prev.scale, 1, hudInsets)
setViewport({ ...t, baseW, baseH })
```

Replace with:

```ts
// Reconstruct the selected path from selection (back-engineering of
// selectedPathKey: path.slice(0, len) where len = path.length - depth).
const sel = untrack(() => context.selection)
const len = sel.path.length - sel.depth
const selectedPath = sel.path.slice(0, Math.max(0, len))
const baseRect = frameRect(context.app.layout, selectedPath, { w: baseW, h: baseH })

// Always fit the new selection. The viewport signal's `equals` is
// epsilon-based — identity→identity is a no-op, sub-pixel drift from
// recomputing against settled geometry is also a no-op, but a real
// change (different selection, real resize) does propagate.
const prev = untrack(() => viewport())
const hudInsets = computeHudInsets(rect)
const t = computeViewportTransform(baseRect, { w: baseW, h: baseH }, prev.scale, hudInsets)
setViewport({ ...t, baseW, baseH })
```

Note `node` lookup is removed; `innerEl` is no longer needed for that purpose. (`innerEl` is still used elsewhere for other things; do not remove the ref.)

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Visual UAT**

Run: `npm run dev`
Open the dev URL. Verify:
- Tap a center frame → no pan, no zoom.
- Tap a deeply nested frame → canvas zooms in to fit.
- Tap a bottom-row frame whose natural position overlaps the bottom HUD → canvas pans to center the frame.
- Resize the window → viewport adapts.
- Layout still renders correctly (no visual regressions from the analytical `frameRect` math).

If proportions are off by a pixel or two, that's likely from the constants (ROOT_PADDING, SIBLING_GAP) not exactly matching CSS — verify against `.layoutContainerRoot` / `.layoutContainer` in `src/app.module.css`.

- [ ] **Step 5: Commit**

```bash
git add src/viewport.ts src/layout-builder.tsx
git commit -m "refactor(viewport): analytical frame rect via tree walk; drop offsetRelativeToRoot"
```

---

## Task 4: Add selectedHandlesState to AppContext

**Files:**
- Modify: `src/types.ts`
- Modify: `src/app.tsx`

Add a new context-level signal that will hold per-direction extend and stick values for whichever frame is currently selected.

- [ ] **Step 1: Add types in types.ts**

In `src/types.ts`, add the type definition near the existing `Direction` type. Just after:

```ts
export type Direction = "top" | "bottom" | "left" | "right"
export type Selection = { path: Array<number>; depth: number }
```

Append:

```ts
/** Per-direction extend (HUD overlap) and stick (canvas overflow) for the
 *  currently selected frame's handles. Owned by layout-builder; read by
 *  the selected Frame to apply via --extend / --stick CSS variables. */
export type SelectedHandlesState = {
  extend: Record<Direction, number>
  stick: Record<Direction, number>
}
```

Then add to the `AppContext` type, after the `setIsAnimating` line:

```ts
  selectedHandlesState: Accessor<SelectedHandlesState>
  setSelectedHandlesState: (state: SelectedHandlesState) => void
```

- [ ] **Step 2: Initialize in app.tsx**

In `src/app.tsx`, near the other `createSignal` calls, add:

```ts
const ZERO_BY_DIR: Record<Direction, number> = { top: 0, bottom: 0, left: 0, right: 0 }
const [selectedHandlesState, setSelectedHandlesState] = createSignal<SelectedHandlesState>(
  { extend: ZERO_BY_DIR, stick: ZERO_BY_DIR },
  { ownedWrite: true },
)
```

(Place this after the existing `isAnimating` signal definition, before the `frameCallbacks` setup.)

- [ ] **Step 3: Update imports in app.tsx**

Find the existing types import:

```ts
import type { AppState, Container, Direction, Entity, HandleOp, Node } from "./types"
```

Update to:

```ts
import type { AppState, Container, Direction, Entity, HandleOp, Node, SelectedHandlesState } from "./types"
```

- [ ] **Step 4: Pass new members through Context value**

In `src/app.tsx`, find the `<Context value={{ ... }}>` JSX. Add the two new members alongside the existing ones:

```tsx
        isAnimating,
        setIsAnimating,
        selectedHandlesState,
        setSelectedHandlesState,
```

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/app.tsx
git commit -m "feat: add selectedHandlesState signal to AppContext"
```

---

## Task 5: Implement layoutPass driver in layout-builder.tsx

**Files:**
- Modify: `src/layout-builder.tsx`

This task replaces `recomputeViewport` with `layoutPass`, which additionally writes `selectedHandlesState`. The frame still uses its own collision logic at this point — both pathways co-exist; the frame ignores the new state until Task 6.

- [ ] **Step 1: Update imports in layout-builder.tsx**

In `src/layout-builder.tsx`, find the import block from `./viewport`:

```ts
import {
  computeViewportTransform,
  frameRect,
  IDENTITY_VIEWPORT,
  selectedPathKey,
  transformToCss,
} from "./viewport"
```

Update to:

```ts
import {
  applyTransform,
  computeExtends,
  computeSticks,
  computeViewportTransform,
  frameRect,
  IDENTITY_VIEWPORT,
  transformToCss,
} from "./viewport"
```

(`selectedPathKey` is no longer needed — `layoutPass` derives the path directly from `selection`.)

- [ ] **Step 2: Replace recomputeViewport with layoutPass**

In `src/layout-builder.tsx`, find the `recomputeViewport` function (the existing block including the `computeHudInsets` helper). Replace the entire `function recomputeViewport()` definition with:

```ts
function layoutPass() {
  if (untrack(() => context.isAnimating())) return
  if (!canvasEl) return
  const canvasRect = canvasEl.getBoundingClientRect()
  const canvas = { w: canvasRect.width, h: canvasRect.height }

  const sel = context.selection
  // Cleared selection (back button) — reset everything.
  if (sel.path.length === 0) {
    setViewport({ ...IDENTITY_VIEWPORT, baseW: canvas.w, baseH: canvas.h })
    context.setSelectedHandlesState({
      extend: { top: 0, bottom: 0, left: 0, right: 0 },
      stick: { top: 0, bottom: 0, left: 0, right: 0 },
    })
    return
  }

  const len = sel.path.length - sel.depth
  const selectedPath = sel.path.slice(0, Math.max(0, len))
  const baseRect = frameRect(context.app.layout, selectedPath, canvas)

  const hudInsets = computeHudInsets(canvasRect)
  const prev = untrack(() => viewport())
  const transform = computeViewportTransform(baseRect, canvas, prev.scale, hudInsets)

  const postRect = applyTransform(baseRect, transform.scale, { x: transform.x, y: transform.y })
  const extend = computeExtends(postRect, canvas, hudInsets)
  const stick = computeSticks(postRect, canvas)

  setViewport({ ...transform, baseW: canvas.w, baseH: canvas.h })
  context.setSelectedHandlesState({ extend, stick })
}
```

(Keep `computeHudInsets` helper as-is from the previous commit.)

- [ ] **Step 3: Update all callers from recomputeViewport to layoutPass**

In `src/layout-builder.tsx`, find every use of `recomputeViewport` and rename to `layoutPass`. Specifically:

Find:
```ts
return context.observeFrame(canvasEl, () => {
  const r = canvasEl.getBoundingClientRect()
  if (r.height > 0) setCanvasAspect(r.width / r.height)
  recomputeViewport()
})
```

Replace with:
```ts
return context.observeFrame(canvasEl, () => {
  const r = canvasEl.getBoundingClientRect()
  if (r.height > 0) setCanvasAspect(r.width / r.height)
  layoutPass()
})
```

Find:
```ts
createEffect(
  () => selectedPathKey(context.selection),
  () => recomputeViewport(),
)
```

Replace with:
```ts
createEffect(
  () => layoutSignature(context.app.layout, context.selection),
  () => layoutPass(),
)
```

(Add the `layoutSignature` helper in the next step.)

Find inside the animation timer's setTimeout:
```ts
recomputeViewport()
context.requestCollisionUpdate()
```

Replace with:
```ts
layoutPass()
context.requestCollisionUpdate()
```

(`requestCollisionUpdate` is still called here so the existing per-frame `checkAllHandles` paths re-fire after animation. It will be removed in Task 7.)

- [ ] **Step 4: Add layoutSignature helper**

In `src/layout-builder.tsx`, add a top-level helper function above the `Breadcrumb` component (or wherever other helpers live). This produces a string that changes whenever the layout topology, the selection path, or selection depth changes — ensuring `createEffect` re-runs `layoutPass` on any such mutation.

```ts
import type { Container, Node, Selection } from "./types"
```

(Update or add this import as needed — `Container` and `Node` are likely already imported; `Selection` is new in this file.)

Then the helper:

```ts
/** Produce a string signature of the layout tree + selection. Reading this
 *  in a createEffect compute makes the effect re-fire whenever any
 *  container's children list, any container's direction, or the selection
 *  path/depth changes. */
function layoutSignature(layout: Container, selection: Selection): string {
  function nodeSignature(node: Node): string {
    if (node.type === "entity") return "e"
    return `${node.direction[0]}(${node.children.map(nodeSignature).join(",")})`
  }
  return `${nodeSignature(layout)}|${selection.path.join(".")}/${selection.depth}`
}
```

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Visual UAT**

Run: `npm run dev`
Open the dev URL. Verify:
- All previous behaviors still work (viewport zoom/pan, breadcrumb scoping, frame handles).
- Tap a frame in a deeply nested layout — viewport behaves correctly.
- Append/split — selection moves to the new entity; viewport adjusts.
- Resize window — viewport adjusts.

Frame handles still use their own per-frame collision logic in this task; UAT is to confirm the viewport changes haven't regressed.

- [ ] **Step 7: Commit**

```bash
git add src/layout-builder.tsx
git commit -m "feat(layout-builder): centralize viewport + handle state in layoutPass"
```

---

## Task 6: Reduce Frame to view-only

**Files:**
- Modify: `src/frame.tsx`

Drop all per-frame collision logic. Frame becomes a presentational component that reads `selectedHandlesState` from context and applies extends/sticks via CSS variables when this frame is the selected one.

- [ ] **Step 1: Replace src/frame.tsx contents**

Replace the entire contents of `src/frame.tsx` with:

```tsx
import { For, Show, createMemo, type JSX, type ParentProps, useContext } from "solid-js"
import { Context } from "./context"
import styles from "./frame.module.css"
import { ArrowIcon } from "./icons"
import type { Direction, HandleSpec } from "./types"

export function Notch(props: {
  ref?: (el: HTMLDivElement) => void
  style?: JSX.CSSProperties
  children: JSX.Element
  class: string
  onClick?(): void
  orientation?: "top" | "bottom" | "left" | "right"
}) {
  const orient = () => props.orientation ?? "bottom"
  return (
    <div
      ref={props.ref}
      class={[styles.notch, styles[`hud-${orient()}`], props.class]}
      style={props.style}
      onClick={e => e.stopPropagation()}
    >
      <div class={styles["notch-backdrop"]}>
        <div class={styles.edge} onClick={props.onClick} />
        <div class={styles.center} onClick={props.onClick} />
        <div class={styles.root} onClick={props.onClick} />
      </div>
      {props.children}
    </div>
  )
}

function ArrowNotch(props: {
  style?: JSX.CSSProperties
  class: string
  icon: JSX.Element
  onClick?(): void
}) {
  return (
    <Notch style={props.style} class={props.class} onClick={props.onClick}>
      {props.icon}
    </Notch>
  )
}

export function Frame(
  props: ParentProps<{
    onClick?: JSX.EventHandlersElement<HTMLDivElement>["onClick"]
    handles?: HandleSpec[]
    style?: JSX.CSSProperties
    class?: string
    "data-path"?: string
    onAddFrame(direction: Direction, op: "append" | "split"): void
  }>,
) {
  const handles = () => props.handles ?? []
  const context = useContext(Context)!

  // True iff this frame is the currently selected one. Equivalent to
  // "we have any handles to render," since handles() is empty for any
  // frame that isn't the selection's targeted scope.
  const isSelected = createMemo(() => handles().length > 0)

  function handleStyle(dir: Direction): JSX.CSSProperties | undefined {
    if (!isSelected()) return undefined
    const state = context.selectedHandlesState()
    const e = state.extend[dir]
    const s = state.stick[dir]
    if (e === 0 && s === 0) return undefined
    const out: Record<string, string> = {}
    if (e > 0) out["--extend"] = `${e}px`
    if (s > 0) out["--stick"] = `${s}px`
    return out as JSX.CSSProperties
  }

  return (
    <div
      onClick={props.onClick}
      style={props.style}
      class={[props.class, styles.frame]}
      data-path={props["data-path"]}
    >
      <Show when={!context.isAnimating()}>
        <For each={handles()}>
          {h => (
            <ArrowNotch
              class={styles[h().dir]}
              icon={<ArrowIcon class={styles.arrow} />}
              style={handleStyle(h().dir)}
              onClick={() => props.onAddFrame(h().dir, h().op)}
            />
          )}
        </For>
      </Show>
      {props.children}
    </div>
  )
}
```

What's gone:
- `extendByDir`, `stickByDir` signals.
- `topEl`/`bottomEl`/`leftEl`/`rightEl` signals and refs.
- `handleEls` map, `visibleCollidable`, `registerDirection`, `overlapAmount`, `checkAllHandles`.
- The 9-signal `createEffect` and `onSettled` ResizeObserver subscription.
- `frameRef` (the wrapper div no longer needs a ref — collision logic is gone).
- `createSignal`, `createEffect`, `onSettled`, `untrack` imports (no longer used).

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Visual UAT**

Run: `npm run dev`
Open the dev URL. Verify:
- Tap a center frame → handles appear, no extends.
- Tap a bottom-row frame → canvas pans, handles fit cleanly with appropriate extends from `selectedHandlesState`.
- Tap a deeply nested frame → viewport adjusts, handles correct.
- Append/split via handles still works.
- Edge-stick: tap a frame whose aspect is so extreme that handles would extend past canvas edges → sticks pull them flush with canvas edges.
- Performance: opening DevTools Performance tab, tapping a frame in a 5+ level nested layout shows a single layoutPass invocation, not N per-frame checkAllHandles.

- [ ] **Step 4: Commit**

```bash
git add src/frame.tsx
git commit -m "refactor(frame): view-only; read selectedHandlesState from context"
```

---

## Task 7: Delete dead collision registry

**Files:**
- Modify: `src/types.ts`
- Modify: `src/app.tsx`
- Modify: `src/layout-builder.tsx`
- Modify: `src/breadcrumb-minimap.tsx`
- Modify: `src/contextual-toolbar.tsx`
- Delete: `src/collision.ts`

Stage B cleanup. After Task 6, nothing reads from the collision registry. Remove all of it.

- [ ] **Step 1: Remove collision-registry members from AppContext type**

In `src/types.ts`, find the `AppContext` type. Remove these members:

```ts
canvasEl: Accessor<HTMLElement | undefined>
setCanvasEl: (el: HTMLElement | undefined) => void
observeFrame: (el: HTMLElement, onResize: () => void) => () => void
registerCollidable: (el: HTMLElement, kind: CollisionKind) => () => void
findCollisions: (el: HTMLElement) => CollisionHit[]
registerUpdateCollision: (cb: () => void) => () => void
requestCollisionUpdate: () => void
```

Also remove the unused import at the top:

```ts
import type { CollisionHit, CollisionKind } from "./collision"
```

- [ ] **Step 2: Remove collision registry from app.tsx**

In `src/app.tsx`, remove these blocks:

The collision registry imports:
```ts
import type { Collidable, CollisionHit, CollisionKind } from "./collision"
import { rectsOverlap } from "./collision"
```

The `frameCallbacks` and `observeFrame`:
```ts
const frameCallbacks = new Set<() => void>()
const controller = new AbortController()
const resizeObserver = new ResizeObserver(() => frameCallbacks.forEach(cb => cb()))
window.addEventListener("resize", () => frameCallbacks.forEach(cb => cb()), controller)

onCleanup(() => {
  resizeObserver.disconnect()
  controller.abort()
})

function observeFrame(el: HTMLElement, cb: () => void) {
  frameCallbacks.add(cb)
  resizeObserver.observe(el)
  return () => {
    frameCallbacks.delete(cb)
    resizeObserver.unobserve(el)
  }
}
```

The collidables set + subscriber set + helpers:
```ts
const collidables = new Set<Collidable>()
const updateSubscribers = new Set<() => void>()

function registerUpdateCollision(cb: () => void) { /* ... */ }
function notifyCollisionUpdate() { /* ... */ }
const requestCollisionUpdate = notifyCollisionUpdate
function registerCollidable(el: HTMLElement, kind: CollisionKind) { /* ... */ }
function findCollisions(el: HTMLElement): CollisionHit[] { /* ... */ }
```

The `canvasEl` signal:
```ts
const [canvasEl, setCanvasEl] = createSignal<HTMLElement | undefined>()
```

The bottom-bar collidable registration effect:
```ts
createEffect(bottomBarEl, bar => {
  if (!bar) return
  return registerCollidable(bar, "hud")
})
```

Also remove `onCleanup` from the imports at the top since the only usage is gone:
```ts
import {
  createEffect,
  createSignal,
  createStore,
  Match,
  onCleanup,  // <-- remove this
  Show,
  Switch,
} from "solid-js"
```

(Verify `onCleanup` is not used elsewhere in `app.tsx` before removing.)

Remove the corresponding entries from the `<Context value={{ ... }}>` JSX:

```tsx
canvasEl,
setCanvasEl,
observeFrame,
registerCollidable,
findCollisions,
registerUpdateCollision,
requestCollisionUpdate,
```

There's also one remaining `createEffect(bottomBarEl, ...)` that just registers the bottom bar with the (now-removed) registry. The first such effect was for the resizeObserver — that's also gone with `frameCallbacks`. Verify both `createEffect(bottomBarEl, ...)` blocks are removed.

- [ ] **Step 3: Remove registerCollidable from breadcrumb-minimap.tsx**

Open `src/layout-builder.tsx`. Inside `Breadcrumb`, find:

```ts
createEffect(context.breadcrumbEl, el => {
  if (!el) return
  return context.registerCollidable(el, "hud")
})
```

Delete this block. (The breadcrumb still needs its `setBreadcrumbEl` ref so that `layout-builder.tsx`'s `computeHudInsets` can find it — that part stays.)

- [ ] **Step 4: Remove registerCollidable from contextual-toolbar.tsx**

In `src/contextual-toolbar.tsx`, find:

```ts
createEffect(context.contextualToolbarEl, el => {
  if (!el) return
  return context.registerCollidable(el, "hud")
})
```

Delete this block. The `setContextualToolbarEl` ref stays.

- [ ] **Step 5: Remove observeFrame, requestCollisionUpdate from layout-builder.tsx**

In `src/layout-builder.tsx`, find the `onSettled` block:

```ts
onSettled(() => {
  if (!canvasEl) return
  context.setCanvasEl(canvasEl)
  // Seed baseW/baseH so the first render has explicit pixel dimensions
  // on canvasInner — required for width/height transitions to animate
  // (browsers won't interpolate between auto and a pixel value).
  const rect = canvasEl.getBoundingClientRect()
  setViewport(v => ({ ...v, baseW: rect.width, baseH: rect.height }))
  setCanvasAspect(rect.height > 0 ? rect.width / rect.height : 1)
  return context.observeFrame(canvasEl, () => {
    const r = canvasEl.getBoundingClientRect()
    if (r.height > 0) setCanvasAspect(r.width / r.height)
    layoutPass()
  })
})
```

Replace with a local ResizeObserver:

```ts
onSettled(() => {
  if (!canvasEl) return
  // Seed baseW/baseH so the first render has explicit pixel dimensions
  // on canvasInner — required for width/height transitions to animate
  // (browsers won't interpolate between auto and a pixel value).
  const rect = canvasEl.getBoundingClientRect()
  setViewport(v => ({ ...v, baseW: rect.width, baseH: rect.height }))
  setCanvasAspect(rect.height > 0 ? rect.width / rect.height : 1)
  const ro = new ResizeObserver(() => {
    const r = canvasEl.getBoundingClientRect()
    if (r.height > 0) setCanvasAspect(r.width / r.height)
    layoutPass()
  })
  ro.observe(canvasEl)
  return () => ro.disconnect()
})
```

(Drop `context.setCanvasEl(canvasEl)` — no consumer.)

Find the animation timer's `setTimeout`:

```ts
animationTimer = setTimeout(() => {
  context.setIsAnimating(false)
  layoutPass()
  context.requestCollisionUpdate()
}, 240)
```

Remove the `requestCollisionUpdate` call:

```ts
animationTimer = setTimeout(() => {
  context.setIsAnimating(false)
  layoutPass()
}, 240)
```

- [ ] **Step 6: Delete src/collision.ts**

```bash
rm /Users/bigmistqke/Documents/GitHub/eddy/.worktrees/handle-fit/src/collision.ts
```

- [ ] **Step 7: Run typecheck**

Run: `npm run typecheck`
Expected: PASS. If any unused-imports errors surface (e.g., `Accessor` from removed types), remove those imports.

- [ ] **Step 8: Visual UAT**

Run: `npm run dev`
Open the dev URL. Final smoke test:
- Recording view → tap `+` → layout view.
- Tap frames at various positions; verify pan/zoom and handle behavior.
- Append/split → new entity selected, viewport adjusts.
- Window resize → viewport adapts.
- No console errors related to missing methods.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: delete dead collision registry"
```

---

## Self-review notes

**Spec coverage:**
- "One function decides everything" → Task 5 (`layoutPass`).
- "Frame geometry analytical, not DOM" → Task 2 (`frameRect`).
- "Center on effective canvas" → Task 3 (`computeViewportTransform` change).
- "Handles never hidden" → preserved (already true on the starting branch).
- "Pure of DOM reads except cached canvas/HUD dims" → Task 5 (`layoutPass` reads `canvasEl.getBoundingClientRect()` and HUD rects only via `computeHudInsets`).
- "Frame view-only" → Task 6.
- "Drop collision registry" → Task 7.
- "`src/collision.ts` deleted" → Task 7 step 6.
- "Constants consolidation" → Task 1.
- "Remove `VIEWPORT_PADDING`" → Task 1 (replaces `ui-constants.ts` contents; `VIEWPORT_PADDING` is not in the new contents).

**Type consistency:**
- `Rect`, `HudInsets`, `SelectedHandlesState` defined once and consumed identically across files.
- `frameRect(layout, path, canvas)` signature consistent in Task 2 (definition) and Task 3 (call site) and Task 5 (call site).
- `computeExtends`, `computeSticks` signatures consistent across Task 2 and Task 5.
- `computeViewportTransform`'s new signature `(baseRect, canvas, minScale, hudInsets)` is consistent in Task 3 (definition) and Task 5 (call site).

**Sequencing rationale:**
- Tasks 1-4 are additive or refactor-in-place; each commits independently with green typecheck.
- Task 5 introduces the new `layoutPass` and `selectedHandlesState` writes. Old per-frame collision logic still active. Both pathways co-exist; this is the only "co-existence" task.
- Task 6 switches Frame to read the new state and drops the old logic.
- Task 7 deletes the now-unused infrastructure.

**Why Task 5 and Task 6 aren't combined:** Task 5 alone is verifiable (viewport behavior preserved). Task 6 alone is the visible behavioral change (frame reads new state). Splitting lets us bisect if a regression appears in either.

**Manual UAT replaces unit tests** since the project has no test framework configured. Verification steps are explicit in Tasks 3, 5, 6, 7.
