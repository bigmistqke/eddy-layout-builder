# Breadcrumb Minimap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the breadcrumb's abstract text labels with recursive DOM mini-tree thumbnails of the layout, and remove the depth-cycle interaction from frame taps.

**Architecture:** A new `MiniNode` component renders a recursive flex tree mirroring the real layout, with one node highlighted per breadcrumb segment. `LayoutBuilder` owns a `canvasAspect` signal driven by its existing canvas `ResizeObserver` and passes it to `Breadcrumb` as a prop. Frame `onClick` becomes a pure selection (`depth: 0`) — no cycling.

**Tech Stack:** Solid 2.x (`solid-js`, `@solidjs/signals`, `@solidjs/web`), TypeScript, CSS Modules, Vite.

**Verification:** No test framework is configured. Each task is verified by `npm run typecheck` and visual UAT in the dev server (`npm run dev`).

**Spec:** `docs/superpowers/specs/2026-05-06-breadcrumb-minimap-design.md`

---

## File map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/breadcrumb-minimap.tsx` | Create | `MiniNode` recursive renderer |
| `src/breadcrumb-minimap.module.css` | Create | Minimap visual rules |
| `src/layout-builder.tsx` | Modify | Add `canvasAspect` signal; rewrite `Breadcrumb` to use `MiniNode` |
| `src/layout-builder.module.css` | Modify | Drop text-button styling; add minimap segment layout |
| `src/node-component.tsx` | Modify | Remove depth-cycle from EntityFrame onClick |

---

## Task 1: Create MiniNode component

**Files:**
- Create: `src/breadcrumb-minimap.tsx`
- Create: `src/breadcrumb-minimap.module.css`

- [ ] **Step 1: Write the CSS module**

Create `src/breadcrumb-minimap.module.css` with:

```css
.miniContainer {
  display: flex;
  flex: 1;
  gap: 1px;
  background: #1a1a1a;
  border-radius: 2px;
  min-width: 0;
  min-height: 0;
}

.miniContainer.row {
  flex-direction: row;
}

.miniContainer.col {
  flex-direction: column;
}

.miniCell {
  flex: 1;
  background: #444;
  border-radius: 1px;
  min-width: 0;
  min-height: 0;
}

.miniHighlight {
  outline: 2px solid var(--color-active);
  outline-offset: -1px;
  background: color-mix(in srgb, var(--color-active) 30%, transparent);
}
```

- [ ] **Step 2: Write the MiniNode component**

Create `src/breadcrumb-minimap.tsx`:

```tsx
import { For, Show } from "solid-js"
import styles from "./breadcrumb-minimap.module.css"
import type { Container, Entity, Node } from "./types"

/**
 * Recursive minimap renderer.
 *
 * `highlightPath` is the path *from this node* to the highlighted descendant.
 * - `highlightPath.length === 0` → this node is the highlighted one.
 * - `highlightPath = [-1]` (any non-matching head) → no descendant is highlighted.
 *
 * The renderer mirrors the real layout's flex behavior at thumbnail scale:
 * each container is a flex row/col matching its `direction`, each entity is a
 * unit-flex cell. Gaps and padding are not faithfully reproduced.
 */
export function MiniNode(props: { node: Node; highlightPath: number[] }) {
  const isHighlighted = () => props.highlightPath.length === 0

  return (
    <Show
      when={props.node.type === "container"}
      fallback={
        <div
          class={[styles.miniCell, isHighlighted() && styles.miniHighlight]
            .filter(Boolean)
            .join(" ")}
        />
      }
    >
      <MiniContainer container={props.node as Container} highlightPath={props.highlightPath} />
    </Show>
  )
}

function MiniContainer(props: { container: Container; highlightPath: number[] }) {
  const isHighlighted = () => props.highlightPath.length === 0
  const head = () => (props.highlightPath.length > 0 ? props.highlightPath[0] : -1)
  const rest = () => props.highlightPath.slice(1)

  return (
    <div
      class={[
        styles.miniContainer,
        props.container.direction === "vertical" ? styles.col : styles.row,
        isHighlighted() && styles.miniHighlight,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <For each={props.container.children}>
        {(child: Entity | Container, i) => (
          <MiniNode node={child} highlightPath={i() === head() ? rest() : [-1]} />
        )}
      </For>
    </div>
  )
}
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors)

- [ ] **Step 4: Commit**

```bash
git add src/breadcrumb-minimap.tsx src/breadcrumb-minimap.module.css
git commit -m "feat: add MiniNode recursive minimap renderer"
```

---

## Task 2: Add canvasAspect signal to LayoutBuilder

**Files:**
- Modify: `src/layout-builder.tsx`

The canvas already has a `ResizeObserver` via `context.observeFrame`. Add a sibling subscription that updates a local `canvasAspect` signal.

- [ ] **Step 1: Add canvasAspect signal and observer**

In `src/layout-builder.tsx`, inside `LayoutBuilder` (after the existing `viewport` signal, before `recomputeViewport`), add:

```tsx
// Canvas aspect ratio (width / height) — driven by the canvas ResizeObserver
// and consumed by Breadcrumb to size minimap segments. Defaults to 1 until
// the first measurement; the breadcrumb briefly renders square segments and
// snaps once the observer fires.
const [canvasAspect, setCanvasAspect] = createSignal(1, { ownedWrite: true })
```

- [ ] **Step 2: Drive the signal from the existing observer**

Modify the existing `onSettled` block (the one that seeds `baseW/baseH` and calls `context.observeFrame`). The current call is:

```tsx
return context.observeFrame(canvasEl, recomputeViewport)
```

Change the body to register both callbacks:

```tsx
onSettled(() => {
  if (!canvasEl) return
  // Seed baseW/baseH so the first render has explicit pixel dimensions
  // on canvasInner — required for width/height transitions to animate
  // (browsers won't interpolate between auto and a pixel value).
  const rect = canvasEl.getBoundingClientRect()
  setViewport(v => ({ ...v, baseW: rect.width, baseH: rect.height }))
  setCanvasAspect(rect.height > 0 ? rect.width / rect.height : 1)
  return context.observeFrame(canvasEl, () => {
    const r = canvasEl.getBoundingClientRect()
    if (r.height > 0) setCanvasAspect(r.width / r.height)
    recomputeViewport()
  })
})
```

- [ ] **Step 3: Pass canvasAspect to Breadcrumb**

Find `<Breadcrumb />` in the JSX and replace with `<Breadcrumb canvasAspect={canvasAspect} />`.

(The Breadcrumb signature is updated in Task 3.)

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: FAIL — Breadcrumb does not yet accept `canvasAspect` prop. This is expected; the next task adds it. The failure should be the only new error.

- [ ] **Step 5: Commit (with the type error — gets resolved in Task 3)**

```bash
git add src/layout-builder.tsx
git commit -m "feat: track canvasAspect signal in LayoutBuilder"
```

---

## Task 3: Rewrite Breadcrumb to render minimaps

**Files:**
- Modify: `src/layout-builder.tsx` (Breadcrumb function only)

- [ ] **Step 1: Update imports**

In `src/layout-builder.tsx`, ensure these imports exist:

```tsx
import type { Accessor } from "solid-js"
import { MiniNode } from "./breadcrumb-minimap"
```

(`Accessor` may already be imported transitively; if `tsc` complains about its absence, add it explicitly.)

- [ ] **Step 2: Replace the Breadcrumb function**

Replace the entire `Breadcrumb` function (the `segments` memo and JSX) with:

```tsx
export function Breadcrumb(props: { canvasAspect: Accessor<number> }) {
  const context = useContext(Context)!

  // Signal-driven collidable registration: ref just sets the signal, this
  // effect owns the lifecycle.
  createEffect(context.breadcrumbEl, el => {
    if (!el) return
    return context.registerCollidable(el, "hud")
  })

  // Each segment carries the highlight path from the layout root to the
  // node-in-scope at that segment's depth. `depth` is the value
  // `selection.depth` should take when this segment is tapped — same shape
  // as the previous text-label version.
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
      // Highlight path from root to this node = path.slice(0, i + 1).
      segs.push({ highlightPath: path.slice(0, i + 1), depth })
    }

    return segs
  })

  // Segment dimensions: fixed height, width = height * canvas aspect, capped.
  const SEGMENT_HEIGHT = 36
  const MAX_SEGMENT_WIDTH = 80
  const segmentSize = () => {
    const w = SEGMENT_HEIGHT * props.canvasAspect()
    return {
      height: `${SEGMENT_HEIGHT}px`,
      width: `${Math.min(MAX_SEGMENT_WIDTH, w)}px`,
    }
  }

  return (
    <Notch
      ref={context.setBreadcrumbEl}
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
                class={[
                  styles.minimapButton,
                  seg().depth === context.selection.depth ? styles.active : "",
                ].join(" ")}
                style={{ height: segmentSize().height, width: segmentSize().width }}
                onClick={() => context.setSelection(s => ({ ...s, depth: seg().depth }))}
              >
                <MiniNode node={context.app.layout} highlightPath={seg().highlightPath} />
              </button>
            </>
          )}
        </For>
      </div>
    </Notch>
  )
}
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/layout-builder.tsx
git commit -m "feat: render breadcrumb segments as minimap thumbnails"
```

---

## Task 4: Update breadcrumb CSS for minimap segments

**Files:**
- Modify: `src/layout-builder.module.css`

- [ ] **Step 1: Replace the breadcrumb button rules**

In `src/layout-builder.module.css`, replace the existing `.breadcrumbContent button`, `.breadcrumbContent button.active`, and `.breadcrumbContent .separator` rules with:

```css
.breadcrumbContent .minimapButton {
  background: none;
  border: none;
  padding: 4px;
  cursor: pointer;
  display: flex;
  align-items: stretch;
  justify-content: stretch;
  border-radius: 4px;
  transition: background 120ms ease;
}

.breadcrumbContent .minimapButton:hover {
  background: rgba(255, 255, 255, 0.05);
}

.breadcrumbContent .minimapButton.active {
  background: rgba(255, 255, 255, 0.08);
}

.breadcrumbContent .separator {
  user-select: none;
  color: #666;
  align-self: center;
}
```

Also adjust `.breadcrumbContent` so its `gap` is tighter and padding accommodates the taller minimaps:

```css
.breadcrumbContent {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-inline: calc(var(--hud-radius) * 2);
  height: 100%;
  color: var(--color-front);
  white-space: nowrap;
}
```

(Remove the `font-size: 12pt;` line — text styling is no longer relevant.)

- [ ] **Step 2: Visual UAT — start dev server**

Run: `npm run dev`
Open the dev URL. With a 2-deep layout (split a frame, then split one of the children), verify:
- Breadcrumb shows three minimap thumbnails separated by `>` arrows.
- Each segment is a small flex tree mirroring the layout shape.
- The active segment (matching `selection.depth`) has a faint background.
- The highlighted region in each minimap shifts from "whole layout" → "container" → "leaf" as you read left to right.
- Tapping a segment pans/zooms the canvas to that ancestor.
- Resizing the window adjusts segment widths (canvas aspect changes).

- [ ] **Step 3: Commit**

```bash
git add src/layout-builder.module.css
git commit -m "style: minimap-friendly breadcrumb segment styling"
```

---

## Task 5: Remove depth-cycling from EntityFrame onClick

**Files:**
- Modify: `src/node-component.tsx`

- [ ] **Step 1: Replace the EntityFrame onClick**

In `src/node-component.tsx`, find the `<EntityFrame ... onClick={...}>` block. Replace the entire `onClick` attribute (currently a multi-branch handler that increments `depth` cyclically) with:

```tsx
onClick={() => {
  const lv = layoutView()
  if (!lv) return
  // Pure selection: tapping a frame selects it as a leaf. Ancestor scoping
  // is now exclusively breadcrumb-driven. (Append mode's "operate on
  // parent" default is preserved by enterAppendMode in app.tsx, which
  // sets depth to 1 when transitioning into the mode — but a fresh tap
  // always reverts to depth=0, the leaf.)
  context.setSelection(() => ({ path: props.path, depth: 0 }))
}}
```

- [ ] **Step 2: Remove the now-unused isNodeActive helper**

The `isNodeActive` function at the top of `src/node-component.tsx` was only used by the cycling logic. Verify with:

Run: `grep -n isNodeActive /Users/bigmistqke/Documents/GitHub/eddy/.worktrees/constraint-zoom/src/node-component.tsx`
Expected: only the function definition remains; no callers.

If no callers, delete the `isNodeActive` function (and its companion `pathEquals` if it's no longer used — but `pathEquals` is also used by `handles()`, so verify with grep before removing). Commands:

Run: `grep -n pathEquals /Users/bigmistqke/Documents/GitHub/eddy/.worktrees/constraint-zoom/src/node-component.tsx`
Expected: at least one call inside `handles()`. Keep `pathEquals`. Remove only `isNodeActive`.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Visual UAT**

Run: `npm run dev` (if not still running). Verify:
- Tapping a frame selects it (`depth: 0`); breadcrumb's last segment becomes active; canvas pans/zooms to the leaf.
- Tapping the same frame again does nothing visible (selection unchanged).
- Tapping a *different* frame selects that one (canvas pans/zooms).
- Tapping a breadcrumb segment scopes up; canvas pans/zooms to the ancestor.
- Append mode and split mode both still work via handles on the currently scoped frame.

- [ ] **Step 5: Commit**

```bash
git add src/node-component.tsx
git commit -m "refactor: remove depth-cycle from frame tap; breadcrumb-only scope-up"
```

---

## Self-review notes

**Spec coverage:**
- "Remove depth-cycle from frame taps" → Task 5.
- "Breadcrumb minimap thumbnails (Option A)" → Tasks 1, 3.
- "Canvas-aspect-driven sizing" → Task 2.
- "No new context plumbing — pass via prop" → Task 2 step 3 + Task 3 signature.
- "Recursive DOM mini-tree" → Task 1 (`MiniNode`).
- "Highlight via outline + tinted background" → Task 1 CSS.
- "Width capped" → Task 3 `MAX_SEGMENT_WIDTH`.
- "Drop text-button styling" → Task 4.

**Type consistency:** `MiniNode` signature is identical across Task 1 (definition) and Task 3 (call site). `canvasAspect` is `Accessor<number>` everywhere. `segmentSize()` returns the same shape used in the JSX `style` prop.

**Manual UAT replaces unit tests** since the project has no test framework configured (per `package.json`). Verification steps are explicit in Tasks 4 and 5.
