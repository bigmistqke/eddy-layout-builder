# Layout Cluster Deepening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deepen the frame-geometry layer of eddy by making layout closed-form (no gap/padding), turning HUD geometry into a reactive value, and consolidating the viewport/handle/HUD-collision decision behind one pure module.

**Architecture:** Three sequential refactors, each behavior-preserving. (A) Remove `gap`/`rootPadding` everywhere — the layout becomes linearly scalable, so the iterative fit-scale machinery collapses to closed-form, and the breadcrumb's separate tree-walk is deleted. (B) Replace the pull-style `computeHudRects(canvasRect)` function with a `hudRects` signal driven by one shared `ResizeObserver`. (C) Extract `computeFrameAffordances` — a pure function `(layout, path|null, canvasSize, hudRects) → { viewport, handles }` — into a new `src/frame-affordances.ts`, leaving `src/viewport.ts` as pure geometry primitives and `canvas.tsx` owning only orchestration + animation.

**Tech Stack:** Solid 2.x (`@solidjs/signals` beta), TypeScript, Vite, Playwright E2E (no unit-test runner — the existing E2E suite in `tests/` is the regression net for these behavior-preserving refactors).

**Testing note:** These are refactors, not features. The discipline is: the existing E2E suite stays green at every commit. Each task runs `pnpm typecheck` (red while mid-refactor, green when done) and the targeted specs listed in the task. Part B introduces one genuinely new observable (HUD-resize drives viewport math) and gets a new failing-first E2E test. Run the full suite with `pnpm test` (builds first) or `pnpm test:fast` (reuses last build); single file with `pnpm exec playwright test tests/<file>`.

**Domain language:** see `CONTEXT.md` (Layout, Selection & handles, HUD sections) and `docs/adr/0001-no-gap-no-padding-closed-form-layout.md`.

---

## File Structure

| File | Responsibility after this plan |
|------|-------------------------------|
| `src/constants.ts` | Handle dims only — `ROOT_PADDING`, `SIBLING_GAP` deleted |
| `src/viewport.ts` | Frame-geometry **primitives** only: `frameRect`, `layoutFrames` (closed-form, no `options`), `handleRects`, `computeExtends`, `computeSticks`, `hasUnescapableHudCollision`, `applyTransform`, types. `computeViewportTransform` + iterative fit fns removed. |
| `src/frame-affordances.ts` | **New.** `computeFrameAffordances` — the composition: fit-scale decision + extend/stick pipeline → `{ viewport, handles }`. |
| `src/components/canvas.tsx` | Orchestration + animation only. `recomputeViewport` calls `computeFrameAffordances` and writes signals; no inline geometry math. |
| `src/hud/breadcrumb.tsx` | Minimap consumes `layoutFrames`; `drawNode` + `GAP` deleted. |
| `src/hud/hud.tsx` | `<Hud>` drops the `kind` prop; `setHudElement(orientation)`. |
| `src/state.ts` | HUD registry (`Map<HTMLElement, HudOrientation>`) + one `ResizeObserver` → `hudRects` signal. `computeHudRects`, `isCanvasZoomed` deleted. New `setCanvasViewportElement`. |
| `src/types.ts` | `HudKind` deleted. `AppContext` gains `hudRects`, `setCanvasViewportElement`; loses `computeHudRects`, `isCanvasZoomed`, `setIsCanvasZoomed`. `setHudElement` signature changes. |
| `src/media/export.ts` | `layoutFrames` call drops the `options` arg. |

---

# Part A — Closed-form frame layout (#1)

Removes `gap`/`rootPadding`. Consequence: `frame(scale s) === frame(1) × s`, so iterative fit-scale becomes division; the breadcrumb's container-fill (only visible through the gap) and its separate walk are deleted.

### Task A1: Delete the layout constants

**Files:**
- Modify: `src/constants.ts:23-28` (the layout block)

- [ ] **Step 1: Confirm the regression baseline is green**

Run: `pnpm test`
Expected: full suite PASS. This is the baseline; every later task must keep it green.

- [ ] **Step 2: Delete `ROOT_PADDING` and `SIBLING_GAP`**

In `src/constants.ts`, delete these lines (currently 23-28):

```ts
// Layout — must stay in sync with --padding in index.css and the
// .layoutContainerRoot/.layoutContainer rules in node-component.module.css.
// Root container has padding on all sides plus gap between children.
// Non-root containers have only gap.
export const ROOT_PADDING = 2
export const SIBLING_GAP = 2
```

Leave `HANDLE_W`, `HANDLE_H`, `HANDLE_BUFFER`, `SAME_AXIS_MIN`, `CROSS_PAIR_MIN` untouched.

- [ ] **Step 3: Run typecheck to verify it fails**

Run: `pnpm typecheck`
Expected: FAIL — `src/viewport.ts` still imports `ROOT_PADDING`, `SIBLING_GAP`. This confirms Task A2 has work to do.

- [ ] **Step 4: Commit**

```bash
git add src/constants.ts
git commit -m "refactor: delete ROOT_PADDING and SIBLING_GAP layout constants"
```

### Task A2: Make `frameRect` and `layoutFrames` closed-form

**Files:**
- Modify: `src/viewport.ts:1` (import), `:250-291` (`frameRect`), `:304-388` (`layoutFrames`)

- [ ] **Step 1: Fix the import line**

`src/viewport.ts:1` becomes:

```ts
import { HANDLE_H, HANDLE_W } from "./constants"
```

- [ ] **Step 2: Rewrite `frameRect` without `options`**

Replace the whole `frameRect` function (currently `:250-291`) with:

```ts
/**
 * Compute a frame's rect from the layout tree and canvas dimensions.
 *
 * Mirrors the CSS flex layout: every container is `display: flex` with
 * children at `flex: 1`, tiling edge-to-edge — no gap, no padding (see
 * ADR-0001). Pure function — no DOM reads.
 */
export function frameRect(
  layout: Node,
  path: number[],
  canvas: { width: number; height: number },
): Rect {
  let rect: Rect = { x: 0, y: 0, width: canvas.width, height: canvas.height }
  let current: Node = layout
  for (const childIndex of path) {
    if (current.type !== "container") {
      break
    }
    const childCount = current.children.length
    if (current.direction === "horizontal") {
      const childWidth = rect.width / childCount
      rect = {
        x: rect.x + childIndex * childWidth,
        y: rect.y,
        width: childWidth,
        height: rect.height,
      }
    } else {
      const childHeight = rect.height / childCount
      rect = {
        x: rect.x,
        y: rect.y + childIndex * childHeight,
        width: rect.width,
        height: childHeight,
      }
    }
    current = current.children[childIndex]
  }
  return rect
}
```

- [ ] **Step 3: Rewrite `layoutFrames` without `options`**

Replace the whole `layoutFrames` function (currently `:316-388`) with:

```ts
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
 *  Layout tiles edge-to-edge — no gap, no padding (see ADR-0001).
 */
export function layoutFrames(
  layout: Node,
  canvas: { width: number; height: number },
  selection: Selection | null = null,
): { leaves: LeafFrame[]; selectedRect: Rect | null } {
  const leaves: LeafFrame[] = []
  let selectedRect: Rect | null = null

  const targetedPath =
    selection === null ? null : selection.path.slice(0, selection.path.length - selection.depth)

  function walk(node: Node, path: number[], rect: Rect) {
    if (targetedPath !== null && pathEquals(path, targetedPath)) {
      selectedRect = rect
    }
    if (node.type === "entity") {
      // Snapshot the color tuple — node.color sits inside the Solid
      // store and would otherwise pass a proxied array reference into
      // the renderer, where reads of leaf.color[0..2] inside the
      // layout-effect's apply trip STRICT_READ_UNTRACKED.
      leaves.push({
        id: node.id,
        path: path.slice(),
        rect,
        color: [node.color[0], node.color[1], node.color[2]],
      })
      return
    }
    const childCount = node.children.length
    if (node.direction === "horizontal") {
      const childWidth = rect.width / childCount
      for (let index = 0; index < childCount; index++) {
        const childRect: Rect = {
          x: rect.x + index * childWidth,
          y: rect.y,
          width: childWidth,
          height: rect.height,
        }
        path.push(index)
        walk(node.children[index], path, childRect)
        path.pop()
      }
    } else {
      const childHeight = rect.height / childCount
      for (let index = 0; index < childCount; index++) {
        const childRect: Rect = {
          x: rect.x,
          y: rect.y + index * childHeight,
          width: rect.width,
          height: childHeight,
        }
        path.push(index)
        walk(node.children[index], path, childRect)
        path.pop()
      }
    }
  }

  walk(layout, [], { x: 0, y: 0, width: canvas.width, height: canvas.height })
  return { leaves, selectedRect }
}
```

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: FAIL — but now only at the *call sites* that still pass `options` (`src/components/canvas.tsx:206-209`, `src/media/export.ts:47-50`). `viewport.ts` itself is clean. This narrows the work to Task A3.

- [ ] **Step 5: Commit**

```bash
git add src/viewport.ts
git commit -m "refactor: make frameRect and layoutFrames closed-form (no gap/padding)"
```

### Task A3: Drop the `options` argument at the `layoutFrames` call sites

**Files:**
- Modify: `src/components/canvas.tsx:202-210`
- Modify: `src/media/export.ts:47-50`

- [ ] **Step 1: Fix the `canvas.tsx` call site**

`src/components/canvas.tsx`, the `drawAt` block (currently `:202-210`) becomes:

```ts
      const { leaves, selectedRect } = untrack(() =>
        layoutFrames(context.app.layout, scaledCanvas, context.app.selection),
      )
```

(The two comment paragraphs above it at `:195-205` describing "song mode vs edit mode" gap/padding are now stale — replace them with a single line: `// Layout tiles the scaled canvas edge-to-edge — see ADR-0001.`)

- [ ] **Step 2: Fix the `export.ts` call site**

`src/media/export.ts:47-50` — replace:

```ts
  const { leaves } = layoutFrames(layout, { width, height }, null, {
    gap: 0,
    rootPadding: 0,
  })
```

with:

```ts
  const { leaves } = layoutFrames(layout, { width, height }, null)
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS — `computeViewportTransform` still uses `frameRect(layout, path, canvas)` with no options, which is now the only signature.

- [ ] **Step 4: Run the layout/viewport specs**

Run: `pnpm test`
Expected: PASS. The fit-scale math now computes against a 0-inset rect instead of a 2px-inset one; `expectFrameRespectsMargin` already assumes `framePadding: 0` (see `tests/helpers.ts:347-348`) and tolerates 3px, so the 2px shift is absorbed. If any spec fails on a >3px delta, STOP and report — that means the 2px was load-bearing somewhere not covered by this plan.

- [ ] **Step 5: Commit**

```bash
git add src/components/canvas.tsx src/media/export.ts
git commit -m "refactor: drop options arg at layoutFrames call sites"
```

### Task A4: Collapse the iterative fit-scale machinery to closed-form

**Files:**
- Modify: `src/viewport.ts:53-161` (the iterative fit functions + their doc comments)

- [ ] **Step 1: Replace `findFitInsideScale`, `findClampOverflowScale`, `findFitScale`, `MAX_FIT_ITER`**

With closed-form layout, `frameRect` at scale `s` equals `frameRect` at scale 1 times `s`. So fit-scale is a single division. Delete `MAX_FIT_ITER` (`:62`), `findFitInsideScale` (`:63-96`), `findClampOverflowScale` (`:98-131`), and `findFitScale` (`:139-161`), plus the multi-paragraph "Two-stage zoom search" / "Iterative in both cases" doc comment block (`:38-61`). Keep `MIN_HANDLE_DIM` (`:137`). Replace all of it with:

```ts
/** Minimum dimension required for both same-axis and cross-pair handle
 *  pairs to fit non-overlapping on a single axis. */
const MIN_HANDLE_DIM = HANDLE_W + 2 * HANDLE_H

/** Closed-form fit-scale. Layout is linearly scalable (ADR-0001), so the
 *  rect at scale 1 scales directly:
 *
 *  - fit-inside (Rule 2): `min` of the axis ratios — frame fits entirely
 *    inside the canvas, binding axis exactly on target.
 *  - clamp-overflow (Rule 3): `max` of the axis ratios — used only when
 *    fit-inside would leave a dimension below `MIN_HANDLE_DIM` (extreme
 *    aspect ratios); the smaller-by-ratio axis fills target, the other
 *    overflows.
 */
function findFitScale(
  layout: Node,
  path: number[],
  canvas: { width: number; height: number },
): number {
  if (canvas.width <= 0 || canvas.height <= 0) {
    return 1
  }
  const rect = frameRect(layout, path, canvas)
  if (rect.width <= 0 || rect.height <= 0) {
    return 1
  }
  const inside = Math.min(canvas.width / rect.width, canvas.height / rect.height)
  // Rule 2 is fine only if both axes still have room for the four handles.
  if (inside * Math.min(rect.width, rect.height) >= MIN_HANDLE_DIM) {
    return inside
  }
  return Math.max(canvas.width / rect.width, canvas.height / rect.height)
}
```

- [ ] **Step 2: Simplify `computeViewportTransform`'s `realRect`**

In `computeViewportTransform` (`:163-212`), the `realRect` recomputation (`:204-208`) was a flex re-walk only because the layout used to be non-linear. It's now `baseRect × scale`. Replace `:204-211`:

```ts
  // Pan to canvas center using REAL flex-math at the scaled canvasInner.
  const realRect = frameRect(layout, path, {
    width: canvas.width * scale,
    height: canvas.height * scale,
  })
  const x = canvas.width / 2 - (realRect.x + realRect.width / 2)
  const y = canvas.height / 2 - (realRect.y + realRect.height / 2)
  return { scale, x, y }
```

with:

```ts
  // Layout is linearly scalable (ADR-0001): the rect at `scale` is the
  // base rect times `scale`. Pan its center to the canvas center.
  const x = canvas.width / 2 - (baseRect.x + baseRect.width / 2) * scale
  const y = canvas.height / 2 - (baseRect.y + baseRect.height / 2) * scale
  return { scale, x, y }
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Run the viewport specs**

Run: `pnpm exec playwright test tests/no-zoom-when-not-needed.spec.ts tests/zoom-pan-smooth.spec.ts tests/aspect-preserved-fit.spec.ts tests/very-deep-frame.spec.ts tests/centered-deep-frame.spec.ts tests/alternating-splits-margin.spec.ts`
Expected: PASS. These exercise both fit-inside and clamp-overflow paths.

- [ ] **Step 5: Run the full suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/viewport.ts
git commit -m "refactor: collapse iterative fit-scale to closed-form"
```

### Task A5: Replace the breadcrumb's tree-walk with `layoutFrames`

**Files:**
- Modify: `src/hud/breadcrumb.tsx:1-86` (imports, `drawNode`, `GAP`, `COLOR_CONTAINER`), `:88-130` (`Minimap` draw effect)

- [ ] **Step 1: Read the current `Minimap` draw effect**

Read `src/hud/breadcrumb.tsx:88-160` to see exactly how `drawNode` is currently called inside the `createEffect` apply and how `highlightPath` / `size` / `aspect` are wired. The replacement must call `layoutFrames` with the same canvas dims the bitmap is sized to, fill each leaf with its colour, and stroke `selectedRect`.

- [ ] **Step 2: Delete `drawNode`, `GAP`, `COLOR_CONTAINER`; add the `layoutFrames` import**

Delete `COLOR_CONTAINER` (`:18`), `GAP` (`:23`), and the entire `drawNode` function (`:25-86`). Add to the imports from `../viewport`:

```ts
import { layoutFrames } from "../viewport"
```

Keep `COLOR_HIGHLIGHT` and `HIGHLIGHT_WIDTH`.

- [ ] **Step 3: Rewrite the `Minimap` draw effect to consume `layoutFrames`**

Inside `Minimap`, replace the body of the `createEffect` apply that currently calls `drawNode` with: build a `selection` from `highlightPath` (`{ path: highlightPath, depth: 0, preview: false }`), call `layoutFrames(layout, currentSize, selection)`, then:

```ts
      canvasContext.clearRect(0, 0, currentSize.width, currentSize.height)
      const { leaves, selectedRect } = layoutFrames(layout, currentSize, {
        path: highlightPath,
        depth: 0,
        preview: false,
      })
      for (const leaf of leaves) {
        canvasContext.fillStyle = rgbToCss(leaf.color)
        canvasContext.fillRect(leaf.rect.x, leaf.rect.y, leaf.rect.width, leaf.rect.height)
      }
      if (selectedRect) {
        canvasContext.strokeStyle = COLOR_HIGHLIGHT
        canvasContext.lineWidth = HIGHLIGHT_WIDTH
        const inset = HIGHLIGHT_WIDTH / 2
        canvasContext.strokeRect(
          selectedRect.x + inset,
          selectedRect.y + inset,
          selectedRect.width - HIGHLIGHT_WIDTH,
          selectedRect.height - HIGHLIGHT_WIDTH,
        )
      }
```

Keep the existing bitmap-resize logic above it (`canvasElement.width/height = currentSize...`). The `aspect` prop stays as-is if it drives the canvas bitmap dimensions — do not change that wiring.

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS. If `Selection` isn't imported in `breadcrumb.tsx`, the inline object literal still satisfies the `layoutFrames` parameter type structurally — no import needed.

- [ ] **Step 5: Run the breadcrumb spec**

Run: `pnpm exec playwright test tests/breadcrumb-minimap.spec.ts`

Note: the spec filename — confirm via `ls tests/ | grep -i breadcrumb`. The design doc is `docs/superpowers/specs/2026-05-06-breadcrumb-minimap-design.md`; if no dedicated spec exists, run `pnpm test` and rely on `tests/smoke.spec.ts` plus visual specs that touch the breadcrumb.
Expected: PASS — the minimap renders identically (container fills were always covered by their children once gap is 0).

- [ ] **Step 6: Commit**

```bash
git add src/hud/breadcrumb.tsx
git commit -m "refactor: breadcrumb minimap consumes layoutFrames instead of own walk"
```

### Task A6: Part A regression gate

- [ ] **Step 1: Full suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 2: Confirm no stray references**

Run: `grep -rn "SIBLING_GAP\|ROOT_PADDING\|MAX_FIT_ITER\|findFitInsideScale\|findClampOverflowScale\|drawNode" src/`
Expected: no output.

- [ ] **Step 3: Commit (only if grep or test surfaced fixups)**

```bash
git add -A && git commit -m "refactor: Part A cleanup"
```

---

# Part B — HUD rects as a reactive value (#2)

Replaces `computeHudRects(canvasRect)` and the four named HUD slots with a generic registry watched by one `ResizeObserver`, exposed as a `hudRects` signal.

### Task B1: Failing E2E test — a HUD resize drives viewport math

**Files:**
- Create: `tests/hud-resize-drives-viewport.spec.ts`

- [ ] **Step 1: Write the failing test**

This is the new observable Part B introduces: today a HUD resizing for its own reasons does not retrigger viewport/handle math. After Part B it does.

```ts
import { test, expect } from "./helpers"
import { activateTool, clickFrame, readViewport } from "./helpers"

test("a HUD growing taller re-runs handle/viewport math", async ({ page }) => {
  await page.goto("/")
  // Enter a tool so handles render and viewport math is active.
  await activateTool(page, "split")
  await clickFrame(page, [])
  await page.waitForTimeout(300)

  const before = await readViewport(page)
  expect(before).not.toBeNull()

  // Grow the bottom (main) HUD by injecting height onto its element.
  // The HUD changing size must, on its own, drive a viewport recompute.
  await page.evaluate(() => {
    const hud = document
      .querySelector("[data-action='toggle-edit']")
      ?.closest("[class*='_hud_']") as HTMLElement | null
    if (!hud) throw new Error("main HUD not found")
    hud.style.minHeight = "240px"
  })
  await page.waitForTimeout(400)

  const after = await readViewport(page)
  expect(after).not.toBeNull()
  // The selected frame's handles now collide with a much taller HUD;
  // the viewport must respond (scale or pan changed).
  const changed =
    Math.abs(after!.x - before!.x) > 1 ||
    Math.abs(after!.y - before!.y) > 1 ||
    Math.abs(after!.scale - before!.scale) > 0.001
  expect(changed).toBe(true)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test:fast -- tests/hud-resize-drives-viewport.spec.ts` (or `pnpm test` if no build exists yet)
Expected: FAIL — `after` equals `before`; today nothing recomputes on a standalone HUD resize.

- [ ] **Step 3: Commit the failing test**

```bash
git add tests/hud-resize-drives-viewport.spec.ts
git commit -m "test: HUD resize should drive viewport math (failing)"
```

### Task B2: Delete `HudKind`; change `setHudElement` to `(orientation)`

**Files:**
- Modify: `src/types.ts:41` (`HudKind`), `:71-120` (`AppContext`)
- Modify: `src/hud/hud.tsx:1-91` (`<Hud>` props + ref)

- [ ] **Step 1: Update `types.ts`**

Delete `HudKind` (`:41`). In `AppContext`, change `setHudElement` (`:81-84`) to:

```ts
  /** Returns a ref-setter for a HUD slot. Wire as
   *  `ref={context.setHudElement("horizontal")}`. The orientation is
   *  the HUD's long axis (see `HudOrientation`). Solid calls the setter
   *  with the element on mount and `undefined` on unmount. */
  setHudElement: (
    orientation: HudOrientation,
  ) => (element: HTMLElement | undefined) => void
```

Delete the `computeHudRects` member (`:86-89`). Add:

```ts
  /** Bounding rects of all mounted HUDs in canvas-relative coords, each
   *  tagged with its long-axis orientation. Driven by a single
   *  ResizeObserver over every HUD element plus the canvas viewport
   *  element. */
  hudRects: Accessor<HudRect[]>
  /** Ref-setter for the canvas viewport element — the box HUD rects are
   *  measured relative to, and the second input to the HUD ResizeObserver. */
  setCanvasViewportElement: (element: HTMLElement | undefined) => void
```

Delete `isCanvasZoomed` and `setIsCanvasZoomed` (`:75-76`).

- [ ] **Step 2: Update `<Hud>` in `hud.tsx`**

Remove `kind` from the `Hud` props type (`:59`), remove the `HudKind` import (`:4`), and change the ref (`:80`) to:

```ts
      ref={context.setHudElement(props.orientation)}
```

- [ ] **Step 3: Remove `kind` from the four `<Hud>` call sites**

Delete the `kind="..."` prop from: `src/hud/main.tsx:160`, `src/hud/menu.tsx:9`, `src/hud/contextual.tsx:26`, `src/hud/breadcrumb.tsx:194` (line numbers approximate — grep `kind=` to find them).

- [ ] **Step 4: Run typecheck to verify it fails in `state.ts`**

Run: `pnpm typecheck`
Expected: FAIL — `src/state.ts` still defines the old `setHudElement`, `computeHudRects`, `isCanvasZoomed`, and imports `HudKind`. Task B3 fixes it.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/hud/hud.tsx src/hud/main.tsx src/hud/menu.tsx src/hud/contextual.tsx src/hud/breadcrumb.tsx
git commit -m "refactor: drop HudKind, setHudElement takes orientation only"
```

### Task B3: HUD registry + single ResizeObserver in `state.ts`

**Files:**
- Modify: `src/state.ts:1-21` (imports), `:84-134` (HUD slots + `computeHudRects`), `:413-437` (returned context)

- [ ] **Step 1: Replace the HUD slot machinery**

In `src/state.ts`, delete the `HudSlot` type, the `hudSlots` record, the `setHudElement` definition, and `computeHudRects` (currently `:84-132`). Delete `isCanvasZoomed`/`setIsCanvasZoomed` (`:134`). Remove `HudKind` from the type import block (`:13`). Add `HudRect` to the `viewport` type import (`:21` already imports `HudRect, ViewportTransform` — keep it). Replace with:

```ts
  // HUD geometry. Every mounted HUD element registers here with its
  // long-axis orientation; one ResizeObserver watches all of them plus
  // the canvas viewport element. Any resize rebuilds `hudRects` —
  // canvas-relative rects consumed by frame-affordances math.
  const hudRegistry = new Map<HTMLElement, HudOrientation>()
  let canvasViewportElement: HTMLElement | undefined
  const [hudRects, setHudRects] = createSignal<HudRect[]>([], { ownedWrite: true })

  function rebuildHudRects() {
    if (canvasViewportElement === undefined || !canvasViewportElement.isConnected) {
      setHudRects([])
      return
    }
    const canvasRect = canvasViewportElement.getBoundingClientRect()
    const rects: HudRect[] = []
    for (const [element, orientation] of hudRegistry) {
      if (!element.isConnected) {
        continue
      }
      const elementRect = element.getBoundingClientRect()
      rects.push({
        x: elementRect.left - canvasRect.left,
        y: elementRect.top - canvasRect.top,
        width: elementRect.width,
        height: elementRect.height,
        orientation,
      })
    }
    setHudRects(rects)
  }

  const hudResizeObserver = new ResizeObserver(rebuildHudRects)

  const setHudElement =
    (orientation: HudOrientation) => (element: HTMLElement | undefined) => {
      if (element === undefined) {
        // Unmount: find and drop whichever element this slot held.
        for (const tracked of hudRegistry.keys()) {
          if (!tracked.isConnected) {
            hudRegistry.delete(tracked)
            hudResizeObserver.unobserve(tracked)
          }
        }
        rebuildHudRects()
        return
      }
      hudRegistry.set(element, orientation)
      hudResizeObserver.observe(element)
      rebuildHudRects()
    }

  function setCanvasViewportElement(element: HTMLElement | undefined) {
    if (canvasViewportElement !== undefined) {
      hudResizeObserver.unobserve(canvasViewportElement)
    }
    canvasViewportElement = element
    if (element !== undefined) {
      hudResizeObserver.observe(element)
    }
    rebuildHudRects()
  }
```

> Note on the unmount branch: Solid calls the ref-setter with `undefined` on unmount but does not pass the old element, so we sweep the registry for disconnected nodes. This is correct because a HUD element is disconnected from the DOM by the time its ref cleanup fires.

- [ ] **Step 2: Update the returned context object**

In the `return { ... }` at the end of `createAppState` (`:413-437`): remove `isCanvasZoomed`, `setIsCanvasZoomed`, `computeHudRects`; add `hudRects`, `setCanvasViewportElement`. Keep `setHudElement` (now the new shape). The `HudOrientation` type is already imported (`:11`).

- [ ] **Step 3: Run typecheck to verify it fails in `canvas.tsx`**

Run: `pnpm typecheck`
Expected: FAIL — `src/components/canvas.tsx` still calls `context.computeHudRects(...)`. Task B4 fixes it.

- [ ] **Step 4: Commit**

```bash
git add src/state.ts
git commit -m "refactor: HUD registry + single ResizeObserver, hudRects signal"
```

### Task B4: Wire `canvas.tsx` to `hudRects` and register the viewport element

**Files:**
- Modify: `src/components/canvas.tsx:287` (the `computeHudRects` call), `:476-483` (the wrapper `<div>` ref)

- [ ] **Step 1: Register the canvas wrapper as the viewport element**

`canvas.tsx` already binds `ref={wrapperElement}` on the outer `<div data-canvas-inner="true">` (`:477-482`). Add a callback ref alongside it that also registers with the context. Change the ref to a function ref:

```tsx
    <div
      ref={element => {
        wrapperElement = element
        context.setCanvasViewportElement(element)
      }}
      class={styles.canvasWrapper}
      onClick={onWrapperClick}
      data-canvas-inner="true"
    >
```

> `wrapperElement` is declared with `!` (`let wrapperElement!: HTMLDivElement` at `:50`); a function ref assigning it keeps every existing `wrapperElement.` usage valid.

- [ ] **Step 2: Replace the `computeHudRects` call**

`canvas.tsx:287` — replace:

```ts
        const hudRects = context.computeHudRects(wrapperRect)
```

with:

```ts
        const hudRects = context.hudRects()
```

> This read is inside `recomputeViewport`'s `untrack` scope, so it's a snapshot — correct, because the effect that calls `recomputeViewport` (the `layoutSignature` effect at `:465`) is not the thing that should react to HUD resizes. Part B's new reactive path is handled in Step 3.

- [ ] **Step 3: Make the viewport-recompute effect react to `hudRects`**

The effect at `canvas.tsx:465-474` currently tracks only `layoutSignature(...)`. Add `hudRects` as a tracked dependency so a HUD resize re-runs `recompute`. Change `:465-474` to:

```ts
  createEffect(
    () => {
      const signature = layoutSignature(
        context.app.layout,
        context.app.selection,
        context.app.tool,
      )
      // Track HUD geometry too — a HUD resizing on its own must
      // re-run handle/viewport math (see ADR / candidate #2).
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
```

> The returned string changes whenever a HUD's rounded size changes, so the effect re-fires. Position-only changes are covered because a HUD only moves when it or the canvas resizes, and the canvas wrapper is observed too (its resize fires `rebuildHudRects` → new array identity → but same string; canvas resize is already handled separately by the `ResizeObserver(syncSize)` at `:347`, so no gap).

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Run the new test — verify it now passes**

Run: `pnpm test:fast -- tests/hud-resize-drives-viewport.spec.ts`
Expected: PASS.

- [ ] **Step 6: Run the HUD/handle specs**

Run: `pnpm exec playwright test tests/handle-clears-bottom-hud.spec.ts tests/append-right-chain-contextual-overlap.spec.ts tests/append-cascade-handles-overlap.spec.ts tests/root-extend-after-back.spec.ts tests/no-spurious-extend.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/canvas.tsx
git commit -m "refactor: canvas consumes hudRects signal, registers viewport element"
```

### Task B5: Part B regression gate

- [ ] **Step 1: Full suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 2: Confirm no stray references**

Run: `grep -rn "computeHudRects\|HudKind\|isCanvasZoomed\|hudSlots" src/`
Expected: no output.

- [ ] **Step 3: Commit (only if fixups were needed)**

```bash
git add -A && git commit -m "refactor: Part B cleanup"
```

---

# Part C — Frame-affordances module (#3)

Extracts `computeFrameAffordances` into a new file. `viewport.ts` keeps only geometry primitives; `canvas.tsx` keeps only orchestration + animation.

### Task C1: Create `frame-affordances.ts` with `computeFrameAffordances`

**Files:**
- Create: `src/frame-affordances.ts`
- Modify: `src/viewport.ts` — move `computeViewportTransform` + `findFitScale` + `MIN_HANDLE_DIM` out

- [ ] **Step 1: Create `src/frame-affordances.ts`**

This composes the geometry primitives that stay in `viewport.ts`. It owns the fit-scale decision and the extend/stick pipeline. `path === null` short-circuits to identity affordances.

```ts
import { HANDLE_H, HANDLE_W } from "./constants"
import type { Node } from "./types"
import type { SelectedHandlesState } from "./types"
import {
  computeExtends,
  computeSticks,
  frameRect,
  hasUnescapableHudCollision,
  IDENTITY_VIEWPORT,
  type HudRect,
  type Rect,
  type ViewportTransform,
} from "./viewport"

const ZERO_BY_DIRECTION = { top: 0, bottom: 0, left: 0, right: 0 } as const

/** What the canvas needs to paint a selected frame: where the viewport
 *  sits, and the per-direction extend/stick for its handles. */
export interface FrameAffordances {
  viewport: ViewportTransform
  handles: SelectedHandlesState
}

const IDENTITY_AFFORDANCES: FrameAffordances = {
  viewport: IDENTITY_VIEWPORT,
  handles: { extend: ZERO_BY_DIRECTION, stick: ZERO_BY_DIRECTION },
}

/** Minimum dimension required for both same-axis and cross-pair handle
 *  pairs to fit non-overlapping on a single axis. */
const MIN_HANDLE_DIM = HANDLE_W + 2 * HANDLE_H

/** Closed-form fit-scale (ADR-0001 — layout is linearly scalable). */
function findFitScale(
  layout: Node,
  path: number[],
  canvas: { width: number; height: number },
): number {
  if (canvas.width <= 0 || canvas.height <= 0) {
    return 1
  }
  const rect = frameRect(layout, path, canvas)
  if (rect.width <= 0 || rect.height <= 0) {
    return 1
  }
  const inside = Math.min(canvas.width / rect.width, canvas.height / rect.height)
  if (inside * Math.min(rect.width, rect.height) >= MIN_HANDLE_DIM) {
    return inside
  }
  return Math.max(canvas.width / rect.width, canvas.height / rect.height)
}

/**
 * The single pure decision for a selected frame: viewport transform plus
 * the per-direction extend/stick for its handles.
 *
 * `path === null` → identity affordances (no frame to compute for — the
 * canvas passes null in song mode, where app policy says "don't zoom").
 * The module itself knows nothing about tools or app modes.
 *
 * Pure function — no DOM reads, no signals. `hudRects` and `canvas` are
 * supplied by the caller (canvas-relative coords).
 */
export function computeFrameAffordances(
  layout: Node,
  path: number[] | null,
  canvas: { width: number; height: number },
  hudRects: HudRect[],
): FrameAffordances {
  if (path === null) {
    return IDENTITY_AFFORDANCES
  }

  const baseRect = frameRect(layout, path, canvas)
  if (baseRect.width === 0 || baseRect.height === 0) {
    return IDENTITY_AFFORDANCES
  }

  // Natural-fit short-circuit: at scale 1, do all 4 handles fit
  // non-overlapping after the natural extends pushed by HUDs?
  const axisCollision = hasUnescapableHudCollision(baseRect, hudRects)
  const naturalExt = computeExtends(baseRect, hudRects)
  const sameAxisH = 2 * HANDLE_H
  const crossPair = HANDLE_W + 2 * HANDLE_H
  const verticalFits = baseRect.height >= sameAxisH + naturalExt.top + naturalExt.bottom
  const horizontalFits = baseRect.width >= sameAxisH + naturalExt.left + naturalExt.right
  const crossWidthFits = baseRect.width >= crossPair
  const crossHeightFits = baseRect.height >= crossPair

  let viewport: ViewportTransform
  if (!axisCollision && verticalFits && horizontalFits && crossWidthFits && crossHeightFits) {
    viewport = IDENTITY_VIEWPORT
  } else {
    const scale = findFitScale(layout, path, canvas)
    const x = canvas.width / 2 - (baseRect.x + baseRect.width / 2) * scale
    const y = canvas.height / 2 - (baseRect.y + baseRect.height / 2) * scale
    viewport = { scale, x, y }
  }

  // Post-transform handle geometry: stick (canvas-edge clamp) first,
  // then extend (HUD clearance) on the resulting stuck rect.
  const postRect: Rect = {
    x: baseRect.x * viewport.scale + viewport.x,
    y: baseRect.y * viewport.scale + viewport.y,
    width: baseRect.width * viewport.scale,
    height: baseRect.height * viewport.scale,
  }
  const stick = computeSticks(postRect, canvas)
  const stuckRect: Rect = {
    x: postRect.x + stick.left,
    y: postRect.y + stick.top,
    width: postRect.width - stick.left - stick.right,
    height: postRect.height - stick.top - stick.bottom,
  }
  const extend = computeExtends(stuckRect, hudRects)

  return { viewport, handles: { extend, stick } }
}
```

> This folds in what `computeViewportTransform` (`viewport.ts:163-212`) and the inline `canvas.tsx` pipeline (`:293-311`) did. The `minScale` parameter of the old `computeViewportTransform` is dropped — `canvas.tsx` always passed `1` (`:290`), so it was dead.

- [ ] **Step 2: Remove `computeViewportTransform`, `findFitScale`, `MIN_HANDLE_DIM` from `viewport.ts`**

Delete `computeViewportTransform` (`:163-212`), `findFitScale` and `MIN_HANDLE_DIM` (added in Task A4) from `src/viewport.ts`. Keep `frameRect`, `layoutFrames`, `handleRects`, `computeExtends`, `computeSticks`, `hasUnescapableHudCollision`, `applyTransform`, `selectedPathKey`, `IDENTITY_VIEWPORT`, and all types/exports. Remove the now-unused doc comment above the deleted `computeViewportTransform`.

- [ ] **Step 3: Run typecheck to verify it fails in `canvas.tsx`**

Run: `pnpm typecheck`
Expected: FAIL — `canvas.tsx` still imports `computeViewportTransform`, `frameRect` (for `realRect`), `computeExtends`, `computeSticks`. Task C2 rewires it.

- [ ] **Step 4: Commit**

```bash
git add src/frame-affordances.ts src/viewport.ts
git commit -m "refactor: extract computeFrameAffordances into frame-affordances.ts"
```

### Task C2: Rewrite `recomputeViewport` to call `computeFrameAffordances`

**Files:**
- Modify: `src/components/canvas.tsx:16-24` (imports), `:266-315` (`recomputeViewport`)

- [ ] **Step 1: Update the imports**

`canvas.tsx:16-24` — the import block from `../viewport` becomes:

```ts
import { layoutFrames, type LeafFrame, type Rect } from "../viewport"
import { computeFrameAffordances } from "../frame-affordances"
```

(`computeViewportTransform`, `frameRect`, `computeExtends`, `computeSticks` are no longer imported here. `Rect` and `LeafFrame` are still used by `drawAt` / the click hit-test / `lastSelectedRect`.)

- [ ] **Step 2: Rewrite `recomputeViewport`**

Replace the whole `recomputeViewport` function (`:266-315`) with:

```ts
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
```

> The perf `console.log` and `performance.now()` instrumentation (old `:272`, `:289-291`, plus the `// eslint-disable` it carried) are dropped — a pure function call has no perf seam worth logging inline. `ZERO_BY_DIRECTION` (`canvas.tsx:30`) is still used by the playback path / handle overlay style block — leave it.

- [ ] **Step 3: Verify `ZERO_BY_DIRECTION` is still referenced**

Run: `grep -n "ZERO_BY_DIRECTION" src/components/canvas.tsx`
Expected: still referenced (the handle-overlay `style` block / playback). If the only remaining reference was the deleted identity branch, delete the `const ZERO_BY_DIRECTION` declaration at `:30` too.

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Run the viewport + handle specs**

Run: `pnpm exec playwright test tests/no-zoom-when-not-needed.spec.ts tests/zoom-pan-smooth.spec.ts tests/aspect-preserved-fit.spec.ts tests/handle-clears-bottom-hud.spec.ts tests/append-cascade-handles-overlap.spec.ts tests/very-deep-frame.spec.ts tests/centered-deep-frame.spec.ts tests/hud-resize-drives-viewport.spec.ts tests/repro-half-out.spec.ts`
Expected: PASS — `recomputeViewport` produces the same `viewport` + `handles` as the old inline pipeline.

- [ ] **Step 6: Commit**

```bash
git add src/components/canvas.tsx
git commit -m "refactor: recomputeViewport calls computeFrameAffordances"
```

### Task C3: Delete the dead `isCanvasZoomed` seam

**Files:**
- Verify: `src/state.ts`, `src/types.ts` — already removed in Task B2/B3. This task is a confirmation pass.

- [ ] **Step 1: Confirm `isCanvasZoomed` is fully gone**

Run: `grep -rn "isCanvasZoomed\|setIsCanvasZoomed" src/`
Expected: no output. (Removed in Tasks B2 + B3. If anything remains — e.g. an unused import — delete it now.)

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit (only if Step 1 surfaced anything)**

```bash
git add -A && git commit -m "refactor: remove dead isCanvasZoomed seam"
```

### Task C4: Part C regression gate

- [ ] **Step 1: Full suite**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 2: Confirm the seam is clean**

Run: `grep -rn "computeViewportTransform" src/`
Expected: no output.

- [ ] **Step 3: Final commit (only if fixups were needed)**

```bash
git add -A && git commit -m "refactor: Part C cleanup"
```

---

## Self-Review Checklist (completed during planning)

**Spec coverage:**
- #1 frame-layout closed-form → Part A (A1–A6): constants deleted, `frameRect`/`layoutFrames` closed-form, call sites fixed, iterative fit collapsed, breadcrumb walk deleted. ✓
- #2 HUD rects reactive → Part B (B1–B5): `HudKind` deleted, `setHudElement(orientation)`, registry + single ResizeObserver, `hudRects` signal, `canvas.tsx` wired, new observable test. ✓
- #3 frame-affordances → Part C (C1–C4): `frame-affordances.ts` created, `computeViewportTransform` removed from `viewport.ts`, `recomputeViewport` rewritten, `isCanvasZoomed` deleted. ✓

**Type consistency:** `computeFrameAffordances(layout, path | null, canvas, hudRects) → FrameAffordances { viewport, handles }` — signature identical in C1 (definition) and C2 (call site). `setHudElement(orientation) => (element | undefined) => void` — identical in B2 (`types.ts`), B2 (`hud.tsx` call), B3 (`state.ts` definition). `hudRects: Accessor<HudRect[]>` — B2 (type), B3 (signal), B4 (consumer).

**Placeholder scan:** no TBD/TODO; every code step shows complete code; every run step shows the exact command + expected result.

**Known approximate line numbers:** `<Hud kind=...>` call-site lines (B2 Step 3) and the breadcrumb spec filename (A5 Step 5) are marked "grep to confirm" — the executor verifies before editing.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-14-layout-cluster-deepening.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
