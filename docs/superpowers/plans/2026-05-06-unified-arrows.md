# Unified Arrows + Center Swap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the split/append mode toggle with a single layout mode where the selected frame shows 4 directional arrows (icon-per-axis-vs-parent) plus a center swap-direction button.

**Architecture:** A new `HandleSpec = { dir, op }` record drives Frame's per-edge rendering: each notch's icon is `+` (append) when its axis matches the parent's flex direction, split-icon (split) otherwise. A center button always present on the selected frame swaps the parent container's direction. Constraint-zoom gets two new minimums for the center button's clearance. The `mode` field on `AppView` and the per-gap append-button rendering go away.

**Tech Stack:** Solid 2.x (`solid-js`, `@solidjs/signals`, `@solidjs/web`), TypeScript, CSS Modules, Vite.

**Verification:** No test framework is configured. Each task is verified by `npm run typecheck` and visual UAT in the dev server (`npm run dev`).

**Spec:** `docs/superpowers/specs/2026-05-06-unified-arrows-design.md`

---

## File map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/icons.tsx` | Modify | Add `class` props to `PlusIcon`/`SplitIcon`; add `SwapIcon` |
| `src/types.ts` | Modify | Drop `mode` from `AppView`; add `HandleOp`, `HandleSpec` |
| `src/viewport.ts` | Modify | Add SWAP constants and constraint terms |
| `src/frame.tsx` | Modify | Refactor `ArrowNotch` to take `icon`; `Frame` accepts `handles: HandleSpec[]`; render center swap button |
| `src/frame.module.css` | Modify | Center swap-button styling |
| `src/node-component.tsx` | Modify | `handles()` produces `HandleSpec[]`; single `onAddFrame(dir, op)` callback; pass swap callback |
| `src/app.tsx` | Modify | Drop mode-related state and bottom-bar buttons; rename `enterAppendMode`; add `swapDirection` |

---

## Task 1: Add SwapIcon and stylable PlusIcon/SplitIcon

**Files:**
- Modify: `src/icons.tsx`

- [ ] **Step 1: Add `class` prop to `PlusIcon`**

In `src/icons.tsx`, replace the existing `PlusIcon` definition with:

```tsx
export function PlusIcon(props: { class?: string }) {
  return (
    <svg
      class={props.class}
      width="35"
      height="35"
      viewBox="0 0 35 35"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M33 19L19.5 19L19.5 33C19.5 34.1046 18.6046 35 17.5 35C16.3954 35 15.5 34.1046 15.5 33L15.5 19L2 19C0.895431 19 -8.69891e-07 18.1046 -8.16818e-07 17C-7.63746e-07 15.8954 0.895431 15 2 15L15.5 15L15.5 2C15.5 0.89543 16.3954 -7.39833e-07 17.5 -6.95908e-07C18.6046 -6.51984e-07 19.5 0.89543 19.5 2L19.5 15L33 15C34.1046 15 35 15.8954 35 17C35 18.1046 34.1046 19 33 19Z"
        fill="currentColor"
      />
    </svg>
  )
}
```

- [ ] **Step 2: Add `class` prop to `SplitIcon`**

Replace `SplitIcon`'s signature similarly:

```tsx
export function SplitIcon(props: { class?: string }) {
  return (
    <svg
      class={props.class}
      width="35"
      height="27"
      viewBox="0 0 35 27"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        fill-rule="evenodd"
        clip-rule="evenodd"
        d="M17.1716 15.5386L22.6762 17.5421C22.36 17.9611 22.1102 18.4257 21.936 18.922C20.9167 21.8263 22.5739 25.0113 26.1744 26.3217C27.9453 26.9662 29.6534 26.985 31.1048 26.3839C32.553 25.784 33.5815 24.6288 34.0489 23.2662C35.022 20.4286 33.5022 17.2258 29.955 15.9347L23.0192 13.4102L29.955 10.8858C33.5022 9.59464 35.022 6.39184 34.0489 3.55419C33.5815 2.19164 32.553 1.0364 31.1048 0.436565C29.6534 -0.164603 27.9453 -0.145793 26.1744 0.498675C22.5739 1.80917 20.9167 4.99408 21.936 7.89846C22.1102 8.39474 22.36 8.85931 22.6762 9.27831L17.1716 11.2819L2.68466 6.00906C1.64677 5.63137 0.499039 6.16654 0.121237 7.2044C-0.256533 8.24232 0.278707 9.39 1.31658 9.76783L11.3239 13.4102L1.31658 17.0526C0.27871 17.4304 -0.256532 18.5781 0.121239 19.616C0.499038 20.6539 1.64677 21.1891 2.68466 20.8114L17.1716 15.5386ZM28.5869 19.6934C29.5207 20.0333 29.9634 20.5147 30.1601 20.8875C30.363 21.2719 30.3719 21.6583 30.2653 21.9691C30.1604 22.2747 29.9345 22.5391 29.5743 22.6883C29.2171 22.8363 28.5617 22.9339 27.5425 22.563C26.5244 22.1924 26.0407 21.68 25.8283 21.2937C25.6133 20.9023 25.6095 20.5317 25.7096 20.2466C25.8083 19.9653 26.0306 19.6992 26.4207 19.5462C26.8121 19.3928 27.5167 19.3039 28.5869 19.6934ZM28.5869 7.12699C29.5207 6.78711 29.9634 6.30568 30.1601 5.93293C30.363 5.54854 30.3719 5.16216 30.2653 4.85127C30.1604 4.54576 29.9345 4.28135 29.5743 4.13211C29.2171 3.98416 28.5617 3.88654 27.5425 4.25745C26.5244 4.628 26.0407 5.14039 25.8283 5.52672C25.6133 5.9181 25.6095 6.28873 25.7096 6.57385C25.8083 6.8551 26.0306 7.12118 26.4207 7.27423C26.8121 7.42767 27.5167 7.51648 28.5869 7.12699Z"
        fill="currentColor"
      />
    </svg>
  )
}
```

- [ ] **Step 3: Add `SwapIcon`**

Append to `src/icons.tsx`:

```tsx
export function SwapIcon(props: { class?: string }) {
  return (
    <svg
      class={props.class}
      width="35"
      height="35"
      viewBox="0 0 35 35"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M2 17.5 L33 17.5 M2 17.5 L8 11.5 M2 17.5 L8 23.5 M33 17.5 L27 11.5 M33 17.5 L27 23.5"
        stroke="currentColor"
        stroke-width="3"
        stroke-linecap="round"
        stroke-linejoin="round"
        fill="none"
      />
      <path
        d="M17.5 2 L17.5 33 M17.5 2 L11.5 8 M17.5 2 L23.5 8 M17.5 33 L11.5 27 M17.5 33 L23.5 27"
        stroke="currentColor"
        stroke-width="3"
        stroke-linecap="round"
        stroke-linejoin="round"
        fill="none"
      />
    </svg>
  )
}
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/icons.tsx
git commit -m "feat(icons): add SwapIcon, classable PlusIcon/SplitIcon"
```

---

## Task 2: Update viewport.ts with center-button constraint

**Files:**
- Modify: `src/viewport.ts`

- [ ] **Step 1: Add SWAP constants**

In `src/viewport.ts`, find the `HANDLE_BUFFER`/`SAME_AXIS_MIN`/`CROSS_PAIR_MIN` block (lines 25-27 in the current file). Replace it with:

```ts
const HANDLE_BUFFER = 20
const SAME_AXIS_MIN = 2 * HANDLE_H + HANDLE_BUFFER
const CROSS_PAIR_MIN = HANDLE_W + 2 * HANDLE_H + HANDLE_BUFFER

// Center swap-button dimensions in CSS pixels — must match the
// `--swap-w`/`--swap-h` CSS variables in frame.module.css.
const SWAP_W = 100
const SWAP_H = 60

// For the center swap button to fit with HANDLE_BUFFER clearance from the
// inner edges of the 4 directional handles (which extend HANDLE_H inward
// from each frame edge):
//
//   • frameW ≥ SWAP_W + 2·HANDLE_H + 2·HANDLE_BUFFER
//   • frameH ≥ SWAP_H + 2·HANDLE_H + 2·HANDLE_BUFFER
const SWAP_FIT_W = SWAP_W + 2 * HANDLE_H + 2 * HANDLE_BUFFER
const SWAP_FIT_H = SWAP_H + 2 * HANDLE_H + 2 * HANDLE_BUFFER
```

- [ ] **Step 2: Update handleScale formula**

Find `computeViewportTransform`'s `handleScale` calculation (lines 97-101):

```ts
const handleScale = Math.max(
  SAME_AXIS_MIN / nw,
  SAME_AXIS_MIN / nh,
  Math.min(CROSS_PAIR_MIN / nw, CROSS_PAIR_MIN / nh),
)
```

Replace with:

```ts
const handleScale = Math.max(
  SAME_AXIS_MIN / nw,
  SAME_AXIS_MIN / nh,
  Math.min(CROSS_PAIR_MIN / nw, CROSS_PAIR_MIN / nh),
  SWAP_FIT_W / nw,
  SWAP_FIT_H / nh,
)
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/viewport.ts
git commit -m "feat(viewport): add center swap-button fit constraint"
```

---

## Task 3: Define HandleSpec types and drop mode from AppView

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Drop mode from AppView and add Handle types**

In `src/types.ts`, find:

```ts
export type AppView = { type: "recording" } | { type: "layout"; mode: "append" | "split" }
export type AppState = { view: AppView; layout: Container }
```

Replace with:

```ts
export type AppView = { type: "recording" } | { type: "layout" }
export type AppState = { view: AppView; layout: Container }

/** Operation a directional handle performs when tapped. */
export type HandleOp = "append" | "split"
export type HandleSpec = { dir: Direction; op: HandleOp }
```

- [ ] **Step 2: Run typecheck (will fail; expected)**

Run: `npm run typecheck`
Expected: FAIL with errors in `app.tsx` and `node-component.tsx` referencing `mode`. These are resolved in Tasks 4 and 5.

- [ ] **Step 3: Do NOT commit yet — proceed to Task 4**

Tasks 3, 4, and 5 form a single coherent change; we commit them together after Task 5 to avoid checking in a non-compiling intermediate state.

---

## Task 4: Refactor Frame to accept HandleSpec[] and render correct icons

**Files:**
- Modify: `src/frame.tsx`

- [ ] **Step 1: Add icon prop to ArrowNotch**

In `src/frame.tsx`, find `ArrowNotch`:

```tsx
function ArrowNotch(props: { ref?: (el: HTMLDivElement) => void; style?: JSX.CSSProperties; class: string; onClick?(): void }) {
  return (
    <Notch ref={props.ref} style={props.style} class={props.class} onClick={props.onClick}>
      <ArrowIcon class={styles.arrow} />
    </Notch>
  )
}
```

Replace with:

```tsx
function ArrowNotch(props: {
  ref?: (el: HTMLDivElement) => void
  style?: JSX.CSSProperties
  class: string
  icon: JSX.Element
  onClick?(): void
}) {
  return (
    <Notch ref={props.ref} style={props.style} class={props.class} onClick={props.onClick}>
      {props.icon}
    </Notch>
  )
}
```

- [ ] **Step 2: Update imports in frame.tsx**

Find the icon import line at the top of `src/frame.tsx`:

```tsx
import { ArrowIcon } from "./icons"
```

Replace with:

```tsx
import { PlusIcon, SplitIcon } from "./icons"
import type { HandleSpec, Direction } from "./types"
```

(Remove `Direction` redeclaration further down — see step 4.)

- [ ] **Step 3: Update Frame's prop type**

Find the `Frame` function signature (`export function Frame(props: ParentProps<{...}>)`). Replace the prop block:

```tsx
    onClick?: JSX.EventHandlersElement<HTMLDivElement>["onClick"]
    handleDirections?: ("top" | "bottom" | "left" | "right")[]
    buttonDirections?: ("top" | "bottom" | "left" | "right")[]
    style?: JSX.CSSProperties
    class?: string
    "data-path"?: string
    onAddFrame(direction: "top" | "bottom" | "left" | "right"): void
```

with:

```tsx
    onClick?: JSX.EventHandlersElement<HTMLDivElement>["onClick"]
    handles?: HandleSpec[]
    style?: JSX.CSSProperties
    class?: string
    "data-path"?: string
    onAddFrame(direction: Direction, op: "append" | "split"): void
    onSwapDirection?: () => void
```

- [ ] **Step 4: Replace dirs/buttonDirs derivations**

Find inside the Frame function:

```tsx
  const dirs = () => props.handleDirections ?? []
  const buttonDirs = () => props.buttonDirections ?? []
  const context = useContext(Context)
  type Direction = "top" | "bottom" | "left" | "right"
```

Replace with:

```tsx
  const handles = () => props.handles ?? []
  const handleByDir = (dir: Direction): HandleSpec | undefined =>
    handles().find(h => h.dir === dir)
  const context = useContext(Context)
```

(The local `type Direction` is dropped since we now import it from `./types`.)

- [ ] **Step 5: Replace the directional handle JSX**

Find the JSX block starting with `<Show when={!handlesHidden() && !context.isAnimating()}>` and the per-direction `<Show when={dirs().includes("top")}>` blocks. Replace the entire `<Show when={!handlesHidden() && !context.isAnimating()}>...</Show>` block with:

```tsx
      <Show when={!handlesHidden() && !context.isAnimating()}>
        <For each={handles()}>
          {h => (
            <ArrowNotch
              ref={el => {
                if (h.dir === "top") setTopEl(el)
                else if (h.dir === "bottom") setBottomEl(el)
                else if (h.dir === "left") setLeftEl(el)
                else setRightEl(el)
              }}
              class={styles[h.dir]}
              icon={
                h.op === "append" ? (
                  <PlusIcon class={styles.arrow} />
                ) : (
                  <SplitIcon class={styles.arrow} />
                )
              }
              style={handleStyle(h.dir)}
              onClick={() => props.onAddFrame(h.dir, h.op)}
            />
          )}
        </For>
        <Show when={props.onSwapDirection}>
          <button
            class={styles["swap-button"]}
            onClick={e => {
              e.stopPropagation()
              props.onSwapDirection?.()
            }}
          >
            <SwapIcon />
          </button>
        </Show>
      </Show>
```

- [ ] **Step 6: Add SwapIcon import**

Update the icons import in `src/frame.tsx` (added in Step 2) to include `SwapIcon`:

```tsx
import { PlusIcon, SplitIcon, SwapIcon } from "./icons"
```

- [ ] **Step 7: Confirm `For` is imported**

Ensure the `solid-js` import line at the top of `src/frame.tsx` includes `For`. The current import is:

```tsx
import {
  createEffect,
  createSignal,
  onSettled,
  Show,
  untrack,
  useContext,
  type JSX,
  type ParentProps,
} from "solid-js"
```

Change to:

```tsx
import {
  createEffect,
  createSignal,
  For,
  onSettled,
  Show,
  untrack,
  useContext,
  type JSX,
  type ParentProps,
} from "solid-js"
```

- [ ] **Step 8: Add swap-button CSS**

In `src/frame.module.css`, append at the end:

```css
.swap-button {
  position: absolute;
  top: 50%;
  left: 50%;
  translate: -50% -50%;
  width: 100px;
  height: 60px;
  border-radius: 30px;
  background: var(--color-back);
  border: none;
  color: var(--color-front);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: var(--z-notch-handle);
  padding: 0;
}
```

The `100px × 60px` matches `SWAP_W × SWAP_H` in `viewport.ts`.

- [ ] **Step 9: Run typecheck (will still fail; expected)**

Run: `npm run typecheck`
Expected: FAIL — `node-component.tsx` and `app.tsx` still reference the old `handleDirections`/`buttonDirections` props on `Frame`. Resolved in Task 5.

- [ ] **Step 10: Do NOT commit yet — proceed to Task 5**

---

## Task 5: Wire NodeComponent and App for unified handles

**Files:**
- Modify: `src/node-component.tsx`
- Modify: `src/app.tsx`

- [ ] **Step 1: Rewrite handles() in node-component.tsx**

Replace the entire contents of `src/node-component.tsx` with:

```tsx
import { omit } from "@solidjs/signals"
import type { ComponentProps, JSX } from "solid-js"
import { createMemo, For, Match, Switch, useContext } from "solid-js"
import styles from "./app.module.css"
import { Context } from "./context"
import { Frame } from "./frame"
import type { Container, Direction, Entity, HandleOp, HandleSpec } from "./types"
import { resolveNode } from "./utils"

function pathEquals(a: number[], b: number[]) {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function opForDirection(
  dir: Direction,
  parentDirection: "horizontal" | "vertical",
): HandleOp {
  const dirAxis = dir === "left" || dir === "right" ? "horizontal" : "vertical"
  return dirAxis === parentDirection ? "append" : "split"
}

function EntityFrame(
  props: ComponentProps<typeof Frame> & {
    entity: Entity
  },
) {
  const rest = omit(props, "entity")
  return (
    <Frame
      {...rest}
      style={{ ...(props.style as JSX.CSSProperties), background: props.entity?.color }}
    />
  )
}

export function NodeComponent(props: {
  layout: Container | Entity
  onAddFrame(path: number[], direction: Direction, op: HandleOp): void
  onSwapDirection(path: number[]): void
  path: Array<number>
}) {
  const context = useContext(Context)!

  const pathKey = createMemo(() => props.path.join("."))

  const handles = createMemo<HandleSpec[]>(() => {
    if (context.app.view.type !== "layout") return []
    const s = context.selection
    const targetedPath = s.path.slice(0, s.path.length - s.depth)
    if (!pathEquals(props.path, targetedPath)) return []

    // Parent direction: for non-root, the container that holds this frame.
    // For root selection, root's own direction (root acts as its own parent).
    const parentDirection: "horizontal" | "vertical" =
      props.path.length === 0
        ? context.app.layout.direction
        : (resolveNode(context.app.layout, props.path.slice(0, -1)) as Container).direction

    const directions: Direction[] = ["top", "bottom", "left", "right"]
    return directions.map(dir => ({ dir, op: opForDirection(dir, parentDirection) }))
  })

  const isSelected = () => handles().length > 0
  const inLayoutView = () => context.app.view.type === "layout"

  return (
    <Switch>
      <Match when={props.layout?.type === "container" && props.layout}>
        {layout => (
          <Frame
            handles={handles()}
            style={{ "flex-direction": layout().direction === "horizontal" ? "row" : "column" }}
            onAddFrame={(direction, op) => props.onAddFrame(props.path, direction, op)}
            onSwapDirection={isSelected() ? () => props.onSwapDirection(props.path) : undefined}
            class={[
              styles.container,
              inLayoutView()
                ? props.path.length === 0
                  ? styles.layoutContainerRoot
                  : styles.layoutContainer
                : "",
            ].join(" ")}
            data-path={pathKey()}
          >
            <For each={layout().children}>
              {(child, index) => (
                <NodeComponent
                  layout={child()}
                  path={[...props.path, index()]}
                  onAddFrame={props.onAddFrame}
                  onSwapDirection={props.onSwapDirection}
                />
              )}
            </For>
          </Frame>
        )}
      </Match>
      <Match when={props.layout?.type === "entity" && props.layout}>
        {entity => (
          <EntityFrame
            entity={entity()}
            data-path={pathKey()}
            handles={handles()}
            class={inLayoutView() ? styles.layoutEntity : undefined}
            onAddFrame={(direction, op) => props.onAddFrame(props.path, direction, op)}
            onSwapDirection={isSelected() ? () => props.onSwapDirection(props.path) : undefined}
            onClick={() => {
              if (!inLayoutView()) return
              context.setSelection(() => ({ path: props.path, depth: 0 }))
            }}
          />
        )}
      </Match>
    </Switch>
  )
}
```

- [ ] **Step 2: Update app.tsx — drop mode, add swap, simplify bottom bar**

In `src/app.tsx`, make these specific changes:

**Change 2a:** Drop `SplitIcon` from the icons import:

Find:

```tsx
import { CloseIcon, PlayIcon, PlusIcon, RecordIcon, SplitIcon } from "./icons"
```

Replace with:

```tsx
import { CloseIcon, PlayIcon, PlusIcon, RecordIcon } from "./icons"
```

**Change 2b:** Add `HandleOp` and `Container` imports if not already present. The current type import is:

```tsx
import type { AppState, Container, Direction, Entity, Node } from "./types"
```

Change to:

```tsx
import type { AppState, Container, Direction, Entity, HandleOp, Node } from "./types"
```

**Change 2c:** Replace `enterAppendMode` with `enterLayoutMode`. Find:

```tsx
  function enterAppendMode() {
    setApp(store => {
      store.view = { type: "layout", mode: "append" }
    })
    if (selection.depth === 0) setSelection(s => ({ ...s, depth: 1 }))
  }

  const layoutView = () =>
    app.view.type === "layout" ? (app.view as { type: "layout"; mode: "append" | "split" }) : null
```

Replace with:

```tsx
  function enterLayoutMode() {
    setApp(store => {
      store.view = { type: "layout" }
    })
  }

  function swapDirection(path: number[]) {
    setApp(proxy => {
      // Swap the parent's direction (for non-root selections) or root's own
      // direction (for root selections — root acts as its own parent).
      const containerToFlip =
        path.length === 0
          ? proxy.layout
          : (resolveNode(proxy.layout, path.slice(0, -1)) as Container)
      containerToFlip.direction =
        containerToFlip.direction === "horizontal" ? "vertical" : "horizontal"
    })
  }

  function handleAddFrame(path: number[], direction: Direction, op: HandleOp) {
    if (op === "append") handleAppend(path, direction)
    else splitNode(path, direction)
  }
```

**Change 2d:** Update the recording-view bottom bar's `+` button to call `enterLayoutMode`. Find:

```tsx
              <Match when={app.view.type === "recording"}>
                <button class={styles.barButton} onClick={() => enterAppendMode()}>
                  <PlusIcon />
                </button>
```

Replace `enterAppendMode()` with `enterLayoutMode()`.

**Change 2e:** Replace the layout-view bottom bar's two mode buttons + close with just close. Find the entire `<Match when={app.view.type === "layout"}>` block (the one with two ModeButtons and a CloseButton):

```tsx
              <Match when={app.view.type === "layout"}>
                <button
                  class={[styles.modeButton, layoutView()?.mode === "append" ? styles.active : ""]}
                  onClick={() => enterAppendMode()}
                >
                  <PlusIcon />
                </button>
                <button
                  class={[styles.modeButton, layoutView()?.mode === "split" ? styles.active : ""]}
                  onClick={() => {
                    setApp(app => {
                      app.view = { type: "layout", mode: "split" }
                    })
                  }}
                >
                  <SplitIcon />
                </button>
                <button
                  class={styles.closeButton}
                  onClick={() => {
                    setApp(app => {
                      app.view = { type: "recording" }
                    })
                  }}
                >
                  <CloseIcon />
                </button>
              </Match>
```

Replace with:

```tsx
              <Match when={app.view.type === "layout"}>
                <button
                  class={styles.closeButton}
                  onClick={() => {
                    setApp(app => {
                      app.view = { type: "recording" }
                    })
                  }}
                >
                  <CloseIcon />
                </button>
              </Match>
```

**Change 2f:** Update both `<NodeComponent>` invocations to pass the new callbacks. Find both invocations:

```tsx
            <NodeComponent
              layout={app.layout}
              path={[]}
              onAppend={handleAppend}
              onSplit={splitNode}
            />
```

Replace each with:

```tsx
            <NodeComponent
              layout={app.layout}
              path={[]}
              onAddFrame={handleAddFrame}
              onSwapDirection={swapDirection}
            />
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Visual UAT (start dev server)**

Run: `npm run dev`
Open the dev URL. Verify:

- Bottom bar in recording view: `+`, Record, Play (unchanged).
- Tap `+` → layout view. Bottom bar shows only the close button.
- Tap a frame: 4 arrow notches appear at edges plus a center swap button.
- For a frame whose parent is horizontal: left/right arrows show `+` icon, top/bottom arrows show split icon.
- For a frame whose parent is vertical: top/bottom show `+`, left/right show split.
- Tap a `+` arrow: a sibling is appended in that direction.
- Tap a split arrow: the frame is wrapped in a new container with a new sibling.
- Tap the center swap button: parent direction flips. Siblings restack along the new axis.
- Tap a breadcrumb segment to scope to root: 4 arrows appear on root with icons reflecting `root.direction`.
- Tap a cross-axis arrow on root with multiple children: existing children are wrapped in an inner container; a new sibling joins at root level.
- Resize the window small: canvas zooms in further than before (because of the new swap-button fit constraint).

- [ ] **Step 5: Single combined commit for tasks 3, 4, 5**

```bash
git add src/types.ts src/frame.tsx src/frame.module.css src/node-component.tsx src/app.tsx
git commit -m "feat: unified arrows + center swap; drop append/split mode"
```

---

## Self-review notes

**Spec coverage:**
- Drop `mode` field from AppView → Task 3, applied in Task 5.
- 4 directional arrows with axis-based icons → Task 4 step 5; op derivation in Task 5 step 1 (`opForDirection`).
- Center swap button → Task 4 steps 5 & 8; wired in Task 5.
- Constraint-zoom update → Task 2.
- Bottom bar mode buttons removed → Task 5 step 2e.
- `enterAppendMode` renamed and depth-defaulting removed → Task 5 step 2c.
- Recording view's Plus enters layout mode → Task 5 step 2d.
- `splitNode`/`appendToContainer` semantics unchanged → never modified.
- SwapIcon → Task 1 step 3.
- `HandleSpec`/`HandleOp` → Task 3.
- Manual UAT → Task 5 step 4.

**Type consistency:**
- `HandleSpec = { dir: Direction; op: HandleOp }` defined in Task 3, consumed identically in Task 4 (`Frame`'s `handles` prop) and Task 5 (`NodeComponent`'s `handles()` memo).
- `onAddFrame(direction: Direction, op: "append" | "split")` is consistent across `Frame` (Task 4 step 3), `NodeComponent` (Task 5 step 1), and `App.handleAddFrame` (Task 5 step 2c).
- `onSwapDirection: () => void` on `Frame`; `(path: number[]) => void` on `NodeComponent`. The `NodeComponent`-level signature takes `path` because `App.swapDirection` needs it; `NodeComponent` partial-applies the path before passing to `Frame`. Done in Task 5 step 1 via `() => props.onSwapDirection(props.path)`.

**Sequencing:**
- Tasks 1, 2 are independent, each commits cleanly.
- Tasks 3, 4, 5 are one coherent change committed together. Intermediate states do not typecheck — explicit in steps 2 & 9 of the involved tasks.

**Why Tasks 3/4/5 share a commit:** the change crosses a strong type boundary (`AppView.mode`) and a prop signature on `Frame`. Splitting commits would leave the repo in a non-compiling state in between, which is worse than a single larger commit for a refactor of this size.
