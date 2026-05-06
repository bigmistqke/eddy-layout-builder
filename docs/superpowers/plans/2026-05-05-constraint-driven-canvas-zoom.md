# Constraint-driven Canvas Zoom Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the canvas in layout mode automatically pan and zoom (via CSS transform) so the currently selected node always renders at a size where its UI fits, unify all HUD chrome on the existing notch component, and replace the old per-direction handle/HUD overlap code with a single generic collision system.

**Architecture:**
- The viewport transform is *derived* from the existing `selection` state. A pure function computes the right `scale + translate` for the selected node's bounding box; the result is applied as a CSS `transform` on the layout root, with a CSS transition for animation. The same layout root publishes its current scale as a `--canvas-scale` CSS variable.
- All in-frame UI (the four notch handles) inverse-scales itself via `transform: scale(calc(1 / var(--canvas-scale)))` so it stays at constant viewport size regardless of the canvas zoom. This makes "zoom in to make the frame big enough for its handles" actually work — the frame grows but handles don't.
- A single generic collision registry sits in `AppContext`. Handles register on mount; HUD notches register on mount. Each handle queries the registry against itself (rendered viewport rect) and decides whether to extend (if it collides with a HUD), hide (if collisions remain after one extend), or render normally.
- Three HUD slots (bottom mode bar, top-left breadcrumb, top-right contextual toolbar) are rendered using the existing `Notch` component, with a new `orientation` prop giving each notch its corner-shape variant.

**Tech Stack:** Solid 2.x (`solid-js`, `@solidjs/signals`), TypeScript, Vite, CSS Modules. No test framework currently configured — verification is via `npx tsc --noEmit` plus `npm run dev` browser checks.

---

## Status

Tasks 1 and 2 are already committed on this branch (`feature/constraint-zoom`). The plan resumes at Task 3.

| # | Task | Status | Commit |
|---|---|---|---|
| 1 | Add BackIcon to icons.tsx | ✅ done | `16b44d8` |
| 2 | Initial ui-constants.ts | ✅ done | `8f11e61` (Task 3 below replaces the obsolete `MIN_NODE_WIDTH/HEIGHT` exports it introduced) |

---

## File Structure

**New files (status: existing or to-be-created):**
- `src/icons.tsx` — already contains `BackIcon` ✅
- `src/ui-constants.ts` — exists ✅; will be trimmed to just `VIEWPORT_PADDING` in Task 3
- `src/collision.ts` — pure helper module (rect-overlap math)
- `src/viewport.ts` — pure functions that compute selected-node path key and viewport transform
- `src/contextual-toolbar.tsx` — top-right notch containing context-sensitive buttons
- `src/contextual-toolbar.module.css` — positioning for the right-edge vertical notch

**Modified files:**
- `src/types.ts` — extend `AppContext` with collision-registry API + `breadcrumbEl` / `contextualToolbarEl` accessors
- `src/app.tsx` — implement the collision registry; provide new accessors; wire up window resize for the registry
- `src/frame.tsx` — extend `Notch` with `orientation` prop; extend `Frame` to accept `data-path`; replace `checkOverlap` with generic collision detection that registers each visible handle and reads the registry
- `src/frame.module.css` — add `.hud-top` / `.hud-right` / `.hud-left` / `.hud-bottom` orientation rules for the Notch backdrop; add `.notch.scaled-inverse` (inverse-scale via `--canvas-scale`)
- `src/node-component.tsx` — pass `data-path` to each rendered Frame
- `src/layout-builder.tsx` — wrap `Breadcrumb` in a top-orientation `Notch`; render `ContextualToolbar`; apply the viewport transform + write `--canvas-scale` on the canvas
- `src/layout-builder.module.css` — replace existing `.breadcrumb` rules with positioning for the new top notch; add `.canvasInner` (the transformed layer) with viewport transition

---

## Task 3: Trim ui-constants.ts

The previous Task 2 (`8f11e61`) added `MIN_NODE_WIDTH`, `MIN_NODE_HEIGHT`, and `VIEWPORT_PADDING`. The new design eliminates the magic-number minimums (Task 8 derives them from actual handle geometry instead). Keep only `VIEWPORT_PADDING`.

**Files:**
- Modify: `src/ui-constants.ts`

- [ ] **Step 1: Replace the file contents**

Replace `src/ui-constants.ts` with:

```ts
// Padding around the selected node when fitting it inside the canvas viewport.
export const VIEWPORT_PADDING = 24
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. (Nothing references the removed exports yet.)

- [ ] **Step 3: Commit**

```bash
git add src/ui-constants.ts
git commit -m "refactor: remove obsolete MIN_NODE constants from ui-constants"
```

---

## Task 4: Collision Registry in AppContext

Add a generic collision registry: a Set of `{ el, kind }` entries that callers can `register(el, kind)` into (returning an unregister function), and query with `findCollisions(el)`.

The registry lives in `App` (alongside `observeFrame`) and is exposed through the context.

**Files:**
- Create: `src/collision.ts` (rect-overlap helper)
- Modify: `src/types.ts`
- Modify: `src/app.tsx`

- [ ] **Step 1: Write the rect-overlap helper**

Create `src/collision.ts`:

```ts
export type CollisionKind = "hud" | "handle"

export type Collidable = { el: HTMLElement; kind: CollisionKind }

export type CollisionHit = { el: HTMLElement; kind: CollisionKind; rect: DOMRect }

export function rectsOverlap(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}
```

- [ ] **Step 2: Extend `AppContext`**

In `src/types.ts`, add the import and extend `AppContext`. The current `AppContext` shape (preserve whatever member names are there now — `app/setApp`, `selection`, etc.) gets these additions:

```ts
import type { CollisionHit, CollisionKind } from "./collision"

// inside AppContext (additions only):
registerCollidable: (el: HTMLElement, kind: CollisionKind) => () => void
findCollisions: (el: HTMLElement) => CollisionHit[]
```

- [ ] **Step 3: Implement in `App`**

In `src/app.tsx`, add the imports:

```tsx
import type { Collidable, CollisionHit, CollisionKind } from "./collision"
import { rectsOverlap } from "./collision"
```

Inside `App`, near the `observeFrame` plumbing, add:

```tsx
const collidables = new Set<Collidable>()

function registerCollidable(el: HTMLElement, kind: CollisionKind) {
  const entry: Collidable = { el, kind }
  collidables.add(entry)
  return () => {
    collidables.delete(entry)
  }
}

function findCollisions(el: HTMLElement): CollisionHit[] {
  const target = el.getBoundingClientRect()
  const hits: CollisionHit[] = []
  for (const c of collidables) {
    if (c.el === el) continue
    const rect = c.el.getBoundingClientRect()
    if (rectsOverlap(target, rect)) hits.push({ el: c.el, kind: c.kind, rect })
  }
  return hits
}
```

Add `registerCollidable` and `findCollisions` to the Context provider's `value` object.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/collision.ts src/types.ts src/app.tsx
git commit -m "feat: generic collision registry in AppContext"
```

---

## Task 5: Handle Inverse-scale CSS

Make the four notch handles inverse-scale themselves so they stay at constant viewport size. The layout root will write `--canvas-scale` later (Task 9); this task adds the consuming side.

**Files:**
- Modify: `src/frame.module.css`

- [ ] **Step 1: Inverse-scale rules**

Append to `src/frame.module.css`:

```css
/*
 * Handles inverse-scale themselves to stay at constant viewport size
 * regardless of the canvas's CSS transform. `--canvas-scale` is written
 * on the layout root by LayoutBuilder; defaults to 1 when absent.
 *
 * The transform-origin pins each handle to its anchor edge so the inverse
 * scaling shrinks toward the edge it sits on rather than away from it.
 */

.notch.bottom {
  transform-origin: bottom center;
  transform: translateX(-50%) scale(calc(1 / var(--canvas-scale, 1)));
}

.notch.top {
  transform-origin: top center;
  transform: translateX(-50%) rotate(180deg) scale(calc(1 / var(--canvas-scale, 1)));
}

.notch.left {
  transform-origin: left center;
  transform: translateY(-50%) rotate(90deg) scale(calc(1 / var(--canvas-scale, 1)));
}

.notch.right {
  transform-origin: right center;
  transform: translateY(-50%) rotate(-90deg) scale(calc(1 / var(--canvas-scale, 1)));
}
```

> The `translateX(-50%)` / `translateY(-50%)` and the `rotate(...)` were previously contributed by separate `&.bottom { left: 50%; ... }` rules. Read the existing rules in this file before editing — if rotation/translation is already declared on the orientation classes, **merge** by adding the `scale(...)` to the same `transform` chain instead of duplicating. The end state is a single `transform` per orientation that combines all needed parts. Verify visually that the bottom mode bar and frame add-handles still render in the same place after this edit.

- [ ] **Step 2: Manually verify the existing app still looks identical**

Run: `npm run dev`. The default `--canvas-scale` (none → falls back to 1) means the inverse-scale is identity. Layout mode handles should look unchanged. Stop dev server.

- [ ] **Step 3: Commit**

```bash
git add src/frame.module.css
git commit -m "feat(frame): handle inverse-scale via --canvas-scale variable"
```

---

## Task 6: data-path Attribute on Frame

Same as previous Task 3 — extend `Frame` to accept and forward `data-path` so the viewport math can locate any node by path.

**Files:**
- Modify: `src/frame.tsx`

- [ ] **Step 1: Extend Frame's prop type**

In `src/frame.tsx`, change Frame's props to include `"data-path"?: string` alongside the existing props. The added line:

```tsx
"data-path"?: string
```

- [ ] **Step 2: Pass through to the root div**

Add `data-path={props["data-path"]}` to the existing root `<div>` inside `Frame`.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/frame.tsx
git commit -m "feat(frame): accept data-path attribute for path-based DOM queries"
```

---

## Task 7: Set data-path from NodeComponent

**Files:**
- Modify: `src/node-component.tsx`

- [ ] **Step 1: Add a path-key memo**

Inside `NodeComponent`, after `const context = useContext(Context)!`, add:

```tsx
const pathKey = createMemo(() => props.path.join("."))
```

- [ ] **Step 2: Pass `data-path` to the container Frame**

Add `data-path={pathKey()}` alongside the existing props on the `<Frame ...>` inside the container `<Match>`.

- [ ] **Step 3: Pass `data-path` to the entity Frame**

Add `data-path={pathKey()}` alongside the existing props on the `<EntityFrame ...>` inside the entity `<Match>`.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Manually verify**

Run: `npm run dev`. In layout mode, every rendered frame `<div>` should have a `data-path` attribute. Stop dev server.

- [ ] **Step 6: Commit**

```bash
git add src/node-component.tsx
git commit -m "feat(node-component): emit data-path on every frame"
```

---

## Task 8: Viewport Math Module

Pure module: given the selection state, layout root, and canvas size, returns `{ scale, x, y }`. Replaces magic minimum-size constants with handle-derived dimensions.

**Files:**
- Create: `src/viewport.ts`

- [ ] **Step 1: Write the module**

Create `src/viewport.ts`:

```ts
import type { Selection } from "./types"
import { VIEWPORT_PADDING } from "./ui-constants"

// Handle dimensions in CSS pixels — derived from frame.module.css and index.css.
// `--hud-height-notch` is 60px; the notch backdrop default width is 100px.
// These give the worst-case footprint of one handle in viewport units.
// If frame.module.css changes, update these to match.
const HANDLE_VIEWPORT_W = 100
const HANDLE_VIEWPORT_H = 60

export type ViewportTransform = { scale: number; x: number; y: number }

export const IDENTITY_VIEWPORT: ViewportTransform = { scale: 1, x: 0, y: 0 }

/** Path key for the selected node — entity path minus `depth` levels. */
export function selectedPathKey(selection: Selection): string {
  const len = selection.path.length - selection.depth
  if (len <= 0) return ""
  return selection.path.slice(0, len).join(".")
}

/** Cumulative un-transformed offset of `el` relative to `root`. Walks the offsetParent chain. */
function offsetRelativeToRoot(el: HTMLElement, root: HTMLElement) {
  let x = 0
  let y = 0
  let cur: HTMLElement | null = el
  while (cur && cur !== root) {
    x += cur.offsetLeft
    y += cur.offsetTop
    cur = cur.offsetParent as HTMLElement | null
  }
  return { x, y, width: el.offsetWidth, height: el.offsetHeight }
}

/**
 * Compute the constraint-correct viewport transform for a selected DOM element.
 *
 * scale = max(handleScale, fitScale) where:
 * - handleScale = smallest scale at which two handles (left+right or top+bottom)
 *   no longer overlap on the selected node — derived from HANDLE_VIEWPORT_*.
 * - fitScale = scale that exactly fills the canvas with VIEWPORT_PADDING margin.
 *
 * If handleScale > fitScale (frame is too small to fit handles AND fit canvas),
 * we use handleScale and let the frame overflow the canvas — handle visibility wins.
 *
 * `node` should be queried *while* the layout root is at the previous transform —
 * `offsetWidth/Height` and `offsetLeft/Top` ignore CSS transforms, so this is safe.
 */
export function computeViewportTransform(
  node: HTMLElement,
  layoutRoot: HTMLElement,
  canvasW: number,
  canvasH: number,
): ViewportTransform {
  const { x: nx, y: ny, width: nw, height: nh } = offsetRelativeToRoot(node, layoutRoot)
  if (nw === 0 || nh === 0) return IDENTITY_VIEWPORT

  const handleScale = Math.max((2 * HANDLE_VIEWPORT_W) / nw, (2 * HANDLE_VIEWPORT_H) / nh)
  const fitScale = Math.min(
    (canvasW - 2 * VIEWPORT_PADDING) / nw,
    (canvasH - 2 * VIEWPORT_PADDING) / nh,
  )
  const scale = Math.max(handleScale, fitScale)

  const nodeCenterX = nx + nw / 2
  const nodeCenterY = ny + nh / 2
  const x = canvasW / 2 - nodeCenterX * scale
  const y = canvasH / 2 - nodeCenterY * scale

  return { scale, x, y }
}

export function transformToCss(t: ViewportTransform) {
  return `translate(${t.x}px, ${t.y}px) scale(${t.scale})`
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/viewport.ts
git commit -m "feat: viewport math with handle-derived constraint dimensions"
```

---

## Task 9: Apply Viewport Transform to LayoutBuilder

Wire the canvas inner to a transform derived from the selection. Also write `--canvas-scale` so handles can inverse-scale.

**Files:**
- Modify: `src/layout-builder.tsx`
- Modify: `src/layout-builder.module.css`

- [ ] **Step 1: Update CSS**

Replace `src/layout-builder.module.css` with:

```css
.layoutBuilder {
  position: relative;
  width: 100%;
  height: 100%;
}

.canvas {
  width: 100%;
  height: 100%;
  position: relative;
  overflow: hidden;
}

.canvasInner {
  position: absolute;
  inset: 0;
  display: flex;
  transform-origin: 0 0;
  will-change: transform;
}

/* legacy plain-text breadcrumb styles — replaced in Task 11 */
.breadcrumb {
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: var(--z-hud);
  display: flex;
  align-items: center;
  gap: 6px;
  background: black;
  border-radius: 8px;
  padding: 6px 10px;
}

.breadcrumb button {
  background: none;
  border: none;
  padding: 0;
  color: var(--color-front);
  font-size: 13px;
  cursor: pointer;
}

.breadcrumb button.active {
  color: var(--color-selection);
  text-decoration: underline;
}

.breadcrumb .separator {
  color: var(--color-front);
  font-size: 13px;
  user-select: none;
}
```

- [ ] **Step 2: Update LayoutBuilder**

Replace `src/layout-builder.tsx`'s `LayoutBuilder` component (keep the existing `Breadcrumb` component above it untouched). Add the imports at the top:

```tsx
import { ComponentProps, createEffect, createMemo, createSignal, For, Show, useContext } from "solid-js"
import { Context } from "./context"
import styles from "./layout-builder.module.css"
import type { Node } from "./types"
import {
  computeViewportTransform,
  IDENTITY_VIEWPORT,
  selectedPathKey,
  transformToCss,
  type ViewportTransform,
} from "./viewport"
```

Replace the `LayoutBuilder` component with:

```tsx
export function LayoutBuilder(props: { children: ComponentProps<"div">["children"] }) {
  const context = useContext(Context)!
  let canvasEl!: HTMLDivElement
  let innerEl!: HTMLDivElement
  const [transform, setTransform] = createSignal<ViewportTransform>(IDENTITY_VIEWPORT)

  // Recompute viewport whenever selection changes.
  // Solid 2.x requires the two-arg createEffect form; the compute function
  // tracks reactivity, the effect function performs side effects.
  createEffect(
    () => selectedPathKey(context.selection),
    key => {
      if (!innerEl || !canvasEl) return

      if (key === "") {
        setTransform(IDENTITY_VIEWPORT)
        return
      }

      const node = innerEl.querySelector<HTMLElement>(`[data-path="${key}"]`)
      if (!node) {
        setTransform(IDENTITY_VIEWPORT)
        return
      }

      const rect = canvasEl.getBoundingClientRect()
      setTransform(computeViewportTransform(node, innerEl, rect.width, rect.height))
    },
  )

  return (
    <div class={styles.layoutBuilder}>
      <div class={styles.canvas} ref={canvasEl}>
        <div
          class={styles.canvasInner}
          ref={innerEl}
          style={{
            transform: transformToCss(transform()),
            "--canvas-scale": String(transform().scale),
          }}
        >
          {props.children}
        </div>
        <Breadcrumb />
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manually verify**

Run: `npm run dev`. Build a small layout (split a few times). Switch to layout mode. Tap a small frame — the canvas should snap (no animation yet — that's the next task) so the selected frame fills most of the viewport with padding, and **the handles should remain at their visual size, not scale up with the frame**. Tap the same frame again — depth-cycle takes you up one tree level and the viewport zooms out. Stop dev server.

- [ ] **Step 5: Commit**

```bash
git add src/layout-builder.tsx src/layout-builder.module.css
git commit -m "feat(layout-builder): apply constraint-driven viewport transform"
```

---

## Task 10: Animate the Viewport

**Files:**
- Modify: `src/layout-builder.module.css`

- [ ] **Step 1: Add the transition**

In `src/layout-builder.module.css`, change the `.canvasInner` rule from:

```css
.canvasInner {
  position: absolute;
  inset: 0;
  display: flex;
  transform-origin: 0 0;
  will-change: transform;
}
```

to:

```css
.canvasInner {
  position: absolute;
  inset: 0;
  display: flex;
  transform-origin: 0 0;
  will-change: transform;
  transition: transform 220ms cubic-bezier(0.4, 0, 0.2, 1);
}
```

- [ ] **Step 2: Manually verify**

Run: `npm run dev`. Tapping frames in layout mode should now smoothly pan + zoom. Stop dev server.

- [ ] **Step 3: Commit**

```bash
git add src/layout-builder.module.css
git commit -m "feat(layout-builder): animate viewport transitions"
```

---

## Task 11: Notch Orientation Prop + HUD Variants

The bottom mode bar's notch backdrop has `corner-top-shape: scoop` / `corner-bottom-shape: square` (bottom-attached look). Other orientations need mirrored corner shapes. Add an `orientation` prop to `Notch` and corresponding CSS rules.

**Files:**
- Modify: `src/frame.tsx`
- Modify: `src/frame.module.css`

- [ ] **Step 1: Extend Notch**

In `src/frame.tsx`, replace the existing `Notch` component with:

```tsx
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
```

- [ ] **Step 2: Add orientation CSS**

Append to `src/frame.module.css`:

```css
/* HUD-orientation modifiers for the Notch component. */

.hud-bottom > .notch-backdrop > .root,
.hud-bottom > .notch-backdrop > .edge {
  corner-top-shape: scoop;
  corner-bottom-shape: square;
}

.hud-top > .notch-backdrop > .root,
.hud-top > .notch-backdrop > .edge {
  corner-top-shape: square;
  corner-bottom-shape: scoop;
}

.hud-right > .notch-backdrop {
  flex-direction: column;
  width: 100%;
  height: 100%;
}
.hud-right > .notch-backdrop > .root,
.hud-right > .notch-backdrop > .edge {
  flex: 0 var(--hud-radius);
}
.hud-right > .notch-backdrop > .root {
  corner-top-left-shape: scoop;
  corner-bottom-left-shape: scoop;
  corner-top-right-shape: square;
  corner-bottom-right-shape: square;
}
.hud-right > .notch-backdrop > .edge {
  corner-top-left-shape: scoop;
  corner-bottom-left-shape: scoop;
}

.hud-left > .notch-backdrop {
  flex-direction: column;
  width: 100%;
  height: 100%;
}
.hud-left > .notch-backdrop > .root,
.hud-left > .notch-backdrop > .edge {
  flex: 0 var(--hud-radius);
}
.hud-left > .notch-backdrop > .root {
  corner-top-right-shape: scoop;
  corner-bottom-right-shape: scoop;
  corner-top-left-shape: square;
  corner-bottom-left-shape: square;
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manually verify the bottom bar still looks identical**

Run: `npm run dev`. Bottom mode bar should be visually unchanged. Stop dev server.

- [ ] **Step 5: Commit**

```bash
git add src/frame.tsx src/frame.module.css
git commit -m "feat(notch): orientation prop with corner-shape variants"
```

---

## Task 12: HUD Element Refs in AppContext

Add `breadcrumbEl` / `contextualToolbarEl` accessors. These are read by frame collision detection (Task 15) and by the legacy `bottomBar` overlap path that still exists for the bottom bar in `frame.tsx`.

**Files:**
- Modify: `src/types.ts`
- Modify: `src/app.tsx`

- [ ] **Step 1: Extend AppContext**

In `src/types.ts`, add to `AppContext` (alongside the existing `bottomBarEl` / `setBottomBarEl`):

```ts
breadcrumbEl: Accessor<HTMLElement | undefined>
setBreadcrumbEl: (el: HTMLElement | undefined) => void
contextualToolbarEl: Accessor<HTMLElement | undefined>
setContextualToolbarEl: (el: HTMLElement | undefined) => void
```

- [ ] **Step 2: Provide them in `App`**

In `src/app.tsx`, after the existing `bottomBarEl` signal, add:

```tsx
const [breadcrumbEl, setBreadcrumbEl] = createSignal<HTMLElement | undefined>()
const [contextualToolbarEl, setContextualToolbarEl] = createSignal<HTMLElement | undefined>()
```

Add the four entries to the Context provider's `value` object.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/app.tsx
git commit -m "feat: HUD element refs in AppContext"
```

---

## Task 13: Move Breadcrumb into Top Notch

**Files:**
- Modify: `src/layout-builder.tsx`
- Modify: `src/layout-builder.module.css`

- [ ] **Step 1: Replace breadcrumb CSS**

In `src/layout-builder.module.css`, remove the legacy `.breadcrumb`, `.breadcrumb button`, `.breadcrumb button.active`, and `.breadcrumb .separator` rules. Replace with:

```css
.breadcrumbNotch {
  --notch-bg: #111;
  --backdrop-x: 0%;
  --backdrop-width: 100%;
  position: absolute;
  top: 0;
  left: 12px;
  height: var(--hud-height-notch);
  z-index: var(--z-hud);
}

.breadcrumbContent {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-inline: var(--hud-radius);
  height: 100%;
  color: var(--color-front);
  font-size: 13px;
  white-space: nowrap;
}

.breadcrumbContent button {
  background: none;
  border: none;
  padding: 0;
  color: var(--color-front);
  font-size: inherit;
  cursor: pointer;
}

.breadcrumbContent button.active {
  color: var(--color-selection);
  text-decoration: underline;
}

.breadcrumbContent .separator {
  user-select: none;
}
```

- [ ] **Step 2: Wrap Breadcrumb in a Notch + register it**

In `src/layout-builder.tsx`, add `Notch` to the imports:

```tsx
import { Notch } from "./frame"
```

Replace the `Breadcrumb` component's `return (...)` with:

```tsx
return (
  <Notch
    ref={el => {
      context.setBreadcrumbEl(el)
      const cleanup = context.registerCollidable(el, "hud")
      onCleanup(cleanup)
    }}
    class={styles.breadcrumbNotch}
    orientation="top"
  >
    <div class={styles.breadcrumbContent}>
      <For each={segments()}>
        {(seg, i) => (
          <>
            <Show when={i() > 0}>
              <span class={styles.separator}>&gt;</span>
            </Show>
            <button
              class={seg().depth === context.selection.depth ? styles.active : ""}
              onClick={() => context.setSelection(s => ({ ...s, depth: seg().depth }))}
            >
              {seg().label}
            </button>
          </>
        )}
      </For>
    </div>
  </Notch>
)
```

Also add `onCleanup` to the imports from `solid-js`.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manually verify**

Run: `npm run dev`. Switch to layout mode. The breadcrumb should now appear as a top-left notch attached to the top edge. Stop dev server.

- [ ] **Step 5: Commit**

```bash
git add src/layout-builder.tsx src/layout-builder.module.css
git commit -m "feat(breadcrumb): render in top notch and register with collision system"
```

---

## Task 14: ContextualToolbar Component

**Files:**
- Create: `src/contextual-toolbar.tsx`
- Create: `src/contextual-toolbar.module.css`
- Modify: `src/layout-builder.tsx` (render it)

- [ ] **Step 1: Styles**

Create `src/contextual-toolbar.module.css`:

```css
.toolbarNotch {
  --notch-bg: #111;
  --backdrop-x: 0%;
  --backdrop-width: 100%;
  position: absolute;
  top: 12px;
  right: 0;
  width: var(--hud-height-notch);
  height: auto;
  z-index: var(--z-hud);
}

.toolbarContent {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding-block: var(--hud-radius);
  width: 100%;
  color: var(--color-front);
}

.toolbarButton {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-front);
}
```

- [ ] **Step 2: Component**

Create `src/contextual-toolbar.tsx`:

```tsx
import { onCleanup, Show, useContext } from "solid-js"
import { Context } from "./context"
import { Notch } from "./frame"
import { BackIcon } from "./icons"
import styles from "./contextual-toolbar.module.css"

export function ContextualToolbar() {
  const context = useContext(Context)!
  const hasSelection = () => context.selection.path.length > 0
  const hasAnyButton = () => hasSelection()

  return (
    <Show when={hasAnyButton()}>
      <Notch
        ref={el => {
          context.setContextualToolbarEl(el)
          const cleanup = context.registerCollidable(el, "hud")
          onCleanup(cleanup)
        }}
        class={styles.toolbarNotch}
        orientation="right"
      >
        <div class={styles.toolbarContent}>
          <Show when={hasSelection()}>
            <button
              class={styles.toolbarButton}
              onClick={() => context.setSelection(() => ({ path: [], depth: 0 }))}
            >
              <BackIcon />
            </button>
          </Show>
        </div>
      </Notch>
    </Show>
  )
}
```

- [ ] **Step 3: Render it in LayoutBuilder**

In `src/layout-builder.tsx`, add:

```tsx
import { ContextualToolbar } from "./contextual-toolbar"
```

And add `<ContextualToolbar />` as a sibling of `<Breadcrumb />` inside `LayoutBuilder`'s JSX:

```tsx
return (
  <div class={styles.layoutBuilder}>
    <div class={styles.canvas} ref={canvasEl}>
      <div class={styles.canvasInner} ref={innerEl} style={{ ... }}>
        {props.children}
      </div>
      <Breadcrumb />
      <ContextualToolbar />
    </div>
  </div>
)
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Manually verify**

Run: `npm run dev`. Layout mode — tap a frame; the top-right contextual toolbar appears with the back arrow. Tapping the back arrow clears selection (path → []) and the toolbar disappears. Stop dev server.

- [ ] **Step 6: Commit**

```bash
git add src/contextual-toolbar.tsx src/contextual-toolbar.module.css src/layout-builder.tsx
git commit -m "feat(contextual-toolbar): right notch with back button + collision register"
```

---

## Task 15: Generic Frame Collision Detection

Replace the existing per-direction `checkOverlap` in `frame.tsx` with a generic implementation that registers each visible handle with the collision system, queries collisions, applies extension if any HUD overlaps, and hides all handles if anything still collides after the extend.

**Files:**
- Modify: `src/frame.tsx`

- [ ] **Step 1: Replace the overlap state and function**

Find the existing block in `frame.tsx`:

```tsx
const [bottomExtend, setBottomExtend] = createSignal(0)
let frameRef!: HTMLDivElement

function checkOverlap() {
  const bar = context.bottomBarEl()
  if (!bar || !frameRef) {
    setBottomExtend(0)
    return
  }
  const frameRect = frameRef.getBoundingClientRect()
  const barRect = bar.getBoundingClientRect()
  const verticalOverlap = frameRect.bottom > barRect.top + 1
  const notchCenterX = (frameRect.left + frameRect.right) / 2
  const horizontalOverlap = notchCenterX + 50 > barRect.left && notchCenterX - 50 < barRect.right
  setBottomExtend(verticalOverlap && horizontalOverlap ? barRect.height : 0)
}

createEffect(context.bottomBarEl, checkOverlap)
onSettled(() => context.observeFrame(frameRef, checkOverlap))
```

Replace with:

```tsx
type Direction = "top" | "bottom" | "left" | "right"

const [extendByDir, setExtendByDir] = createStore<Record<Direction, number>>({
  top: 0,
  bottom: 0,
  left: 0,
  right: 0,
})
const [handlesHidden, setHandlesHidden] = createSignal(false)
let frameRef!: HTMLDivElement
const handleRefs: Partial<Record<Direction, HTMLElement>> = {}

function overlapAmount(handle: DOMRect, hud: DOMRect, dir: Direction): number {
  // How much does the hud's bounds extend INTO the handle along the handle's axis?
  // For top/bottom: vertical overlap. For left/right: horizontal overlap.
  switch (dir) {
    case "bottom":
      return Math.max(0, handle.bottom - hud.top)
    case "top":
      return Math.max(0, hud.bottom - handle.top)
    case "right":
      return Math.max(0, handle.right - hud.left)
    case "left":
      return Math.max(0, hud.right - handle.left)
  }
}

function checkAllHandles() {
  const directions: Direction[] = ["top", "bottom", "left", "right"]
  let anyStillCollides = false
  const newExtends: Record<Direction, number> = { top: 0, bottom: 0, left: 0, right: 0 }

  for (const dir of directions) {
    const handle = handleRefs[dir]
    if (!handle) continue

    const hits = context.findCollisions(handle)
    if (hits.length === 0) continue

    // Try to extend over any HUD it collides with (largest overlap wins)
    const handleRect = handle.getBoundingClientRect()
    let extend = 0
    for (const hit of hits) {
      if (hit.kind === "hud") {
        extend = Math.max(extend, overlapAmount(handleRect, hit.rect, dir))
      }
    }
    newExtends[dir] = extend

    // Re-check after extend (we can't physically apply yet — just simulate)
    // Conservatively: if any handle-vs-handle collision OR a hud collision
    // larger than what we'd extend by, we still collide.
    const stillCollidesWithHandle = hits.some(h => h.kind === "handle")
    if (stillCollidesWithHandle) anyStillCollides = true
  }

  if (anyStillCollides) {
    setHandlesHidden(true)
    setExtendByDir(reconcile({ top: 0, bottom: 0, left: 0, right: 0 }))
  } else {
    setHandlesHidden(false)
    setExtendByDir(reconcile(newExtends))
  }
}

// Re-run when any HUD ref changes. Compute tracks; effect runs the check.
// Solid 2.x: two-arg createEffect form is mandatory.
createEffect(
  () => {
    context.bottomBarEl()
    context.breadcrumbEl()
    context.contextualToolbarEl()
  },
  () => checkAllHandles(),
)
onSettled(() => context.observeFrame(frameRef, checkAllHandles))
```

> Add `createStore` and `reconcile` to the imports from `@solidjs/signals` (they already use `omit`). Add `createSignal` if not present. Add `Direction` import or define locally as above.

- [ ] **Step 2: Register each handle on mount + render conditionally**

Each `<ArrowNotch>` and `<EdgeButton>` inside `Frame` needs:
1. A ref that captures the handle element into `handleRefs[dir]`
2. A `style` that applies `--extend: <extendByDir[dir]>px`
3. To not render at all when `handlesHidden()` is true

Wrap the existing four `<Show when={dirs().includes("top")}>` blocks (etc.) inside one outer `<Show when={!handlesHidden()}>`. Inside each direction block, replace the `<ArrowNotch>` element with a version that:
- captures the ref:

```tsx
<ArrowNotch
  ref={el => {
    handleRefs.top = el
    const cleanup = context.registerCollidable(el, "handle")
    onCleanup(cleanup)
  }}
  class={styles.top}
  style={extendByDir.top > 0 ? { "--extend": `${extendByDir.top}px` } : undefined}
  onClick={() => props.onAddFrame("top")}
/>
```

> **`ArrowNotch` doesn't currently accept a `ref` prop.** Extend it (in the same file) to take an optional `ref?: (el: HTMLDivElement) => void` and forward it to its inner `<Notch>`'s `ref`. Same for `EdgeButton` — it should accept and apply a `ref?: (el: HTMLButtonElement) => void` to its `<button>`. Adjust handle ref types accordingly (`HTMLDivElement | HTMLButtonElement`).

Apply the same pattern to bottom/left/right.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manually verify**

Run: `npm run dev`. Various scenarios:
- Frame whose bottom edge sits at the bottom mode bar → bottom handle extends
- Frame whose top edge sits at the breadcrumb → top handle extends
- Frame whose right edge sits at the contextual toolbar → right handle extends
- Tiny frame (deeply split layout) → handles hide entirely; tap the frame → canvas zooms in → handles reappear

Stop dev server.

- [ ] **Step 5: Commit**

```bash
git add src/frame.tsx
git commit -m "feat(frame): generic collision-driven handle visibility and extension"
```

---

## Task 16: Recompute Viewport on Canvas Resize

**Files:**
- Modify: `src/layout-builder.tsx`

- [ ] **Step 1: Track resize via observeFrame**

In `LayoutBuilder`, add a resize tick and tie it into the viewport effect. Use `onSettled` for the one-shot observer registration; use the two-arg `createEffect` for the viewport recomputation (Solid 2.x requires the two-arg form):

```tsx
const [resizeTick, setResizeTick] = createSignal(0)

onSettled(() => {
  if (!canvasEl) return
  return context.observeFrame(canvasEl, () => setResizeTick(t => t + 1))
})

createEffect(
  () => {
    resizeTick()
    return selectedPathKey(context.selection)
  },
  key => {
    if (!innerEl || !canvasEl) return

    if (key === "") {
      setTransform(IDENTITY_VIEWPORT)
      return
    }

    const node = innerEl.querySelector<HTMLElement>(`[data-path="${key}"]`)
    if (!node) {
      setTransform(IDENTITY_VIEWPORT)
      return
    }

    const rect = canvasEl.getBoundingClientRect()
    setTransform(computeViewportTransform(node, innerEl, rect.width, rect.height))
  },
)
```

(This replaces the existing viewport `createEffect` from Task 9.)

> Add `onSettled` to the imports from `solid-js`.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manually verify**

Run: `npm run dev`. Tap a frame to zoom in; resize the window; viewport should recompute and the frame stays centered. Stop dev server.

- [ ] **Step 4: Commit**

```bash
git add src/layout-builder.tsx
git commit -m "feat(layout-builder): recompute viewport on canvas resize"
```

---

## Self-Review Checklist

- **Spec coverage:**
  - "Selection drives viewport (pan + zoom)" → Tasks 8, 9, 16
  - "Containers as selectable nodes" → Tasks 7, 8 (no node-type special-casing)
  - "HUD: notched language everywhere" → Tasks 11, 13, 14
  - "Contextual toolbar hidden when no tools" → Task 14
  - "Back button" → Task 14
  - "Generic collision system (handles + HUDs)" → Tasks 4, 13, 14, 15
  - "Handles fixed viewport size via --canvas-scale" → Tasks 5, 9
  - "Constraint detection without magic numbers (handle-derived)" → Task 8
  - "Animation" → Task 10
- **Placeholder scan:** No "TBD" / "TODO" / "implement later" in code blocks.
- **Type consistency:** `registerCollidable` / `findCollisions` shape matches between Task 4, Task 13, Task 14, and Task 15.

---

## Notes for Implementer

- Solid 2.x. No test framework — verification is `npx tsc --noEmit` plus browser smoke-checks.
- **Solid 2.x `createEffect` is two-arg only.** The single-arg form `createEffect(fn)` is explicitly deprecated in `@solidjs/signals` and will be a type error. Always use `createEffect(compute, effect)`. To track multiple sources, read them all inside the `compute` function. For "run once after mount" patterns, use `onSettled(callback)` instead of a no-tracking `createEffect`.
- The `--extend` CSS variable convention is already in `frame.module.css` — uniform across all four directions; no new CSS variables needed for it.
- When tuning `HANDLE_VIEWPORT_W` / `HANDLE_VIEWPORT_H` in `viewport.ts`, measure the rendered notch dimensions at scale 1 and update the constants if the CSS changes.
- When committing, never add `Co-Authored-By` lines.
