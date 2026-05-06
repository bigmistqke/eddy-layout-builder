# Constraint-driven canvas zoom

## Problem

In layout mode, every frame renders UI inside it — currently the four notch handles for splitting and circular edge buttons for appending. As the user splits the layout further, individual frames shrink. Below a certain size, this UI no longer fits in the frame: handles overlap each other, edge buttons collide with notches, and the experience breaks down.

The constraint is general, not handle-specific: **every frame in layout mode must have enough rendered space to display its in-frame UI.** New UI added later (labels, inline controls) inherits the same constraint.

## Solution

The canvas (the layout root) is scaled and translated so the **selected node** is rendered at exactly the size it needs to fit its UI — with a configurable padding around it inside the viewport. The transformation is purely visual; the underlying layout tree is unchanged. Selecting a smaller node zooms in; selecting a larger one zooms out.

A critical co-design: **the in-frame UI (handles, edge buttons) is rendered at constant viewport size and does not scale with the canvas.** Without this, zoom would scale handles and frames together and the relative geometry — and therefore any handle-handle overlap — would be invariant under zoom, defeating the purpose. Implementation: the layout root publishes its current scale as a `--canvas-scale` CSS variable; each handle applies `transform: scale(calc(1 / var(--canvas-scale)))` with a `transform-origin` that pins it to its anchor edge.

This is the only mechanism. There is no manual pan, no manual pinch zoom, no scroll-wheel zoom, and no keyboard shortcuts. The viewport is fully determined by what's selected.

## Interaction model

### Selection drives the viewport

The existing `selection` state is `{ path, depth }`. The **selected node** is the ancestor `depth` levels up from the entity at `path`. At `depth: 0`, the selected node is the entity itself; at higher depths, it's an ancestor container.

The viewport always animates (pan + zoom) to the **constraint-correct fit for the selected node**. Constraint-correct means: the smallest scale at which the selected node's UI (handles, edge buttons, future controls) renders without overflowing — plus a configurable padding around the selected node within the viewport.

Zoom can move in either direction. Selecting a smaller node zooms in; selecting a larger node (parent, distant sibling) zooms out. There is no "stay zoomed" rule — every selection change reanchors the viewport to fit the new selection.

### Tap behavior

The existing tap behavior is preserved unchanged. The viewport simply follows whatever selection the existing logic produces:

| User action | Existing selection effect | Viewport effect |
|---|---|---|
| Tap a frame for the first time / after a different frame | Selection moves to that frame's path with mode-appropriate depth (0 in split, 1 in append) | Animate to fit the new selected node |
| Tap the currently selected frame again | `depth` increments (with wraparound at root) — selection climbs to parent, grandparent, etc. | Animate to fit the now-larger selected node — i.e., zoom out one tree level per repeated tap |

Repeated tap on the same frame thus becomes a natural "climb the tree" gesture: each tap zooms out one level. The wraparound at root means a final tap returns to the entity (and zooms back in).

### Containers as selectable nodes

The selected node can be an entity or a container. Both render UI in layout mode (split-mode handles wrap whichever node is targeted; append-mode edge buttons live on children of the targeted container). The constraint check and the fit-with-padding calculation apply to whichever the selected node is — there is no special-casing per node type.

### HUD: notched language everywhere

All HUD chrome — mode bar, breadcrumb, contextual toolbar — uses the existing `Notch` component (the same one already in use for the bottom mode bar). This unifies the visual language: every floating HUD piece reads as a notch attached to a canvas edge.

Three notch slots:

| Slot | Position | Orientation | Contents |
|---|---|---|---|
| Bottom mode bar | bottom-center, attached to bottom | horizontal | existing mode/record buttons (unchanged) |
| Breadcrumb | top-left, attached to top | horizontal | breadcrumb segments, growing rightward |
| Contextual toolbar | top-right, attached to right edge | vertical | back button (first); future contextual actions append below |

The contextual toolbar notch only renders when at least one contextual button has something to show. When there are no contextual tools active (e.g., no selection → no back button, no other tools applicable), the entire notch is hidden — not just its contents. The notch is a consequence of having context, not a permanent fixture.

### Handle collisions with HUD

Handles use the same generic collision system described above — there is no per-direction or per-HUD special-casing. Every visible handle queries the registry against every visible HUD; the result tells the handle whether to extend, hide, or render normally. Adding a new HUD or a new handle direction in the future requires only registering it; no new collision code.

### Back button

The back button is the first occupant of the top-right contextual toolbar notch. It is the supplied left-arrow SVG. It is visible whenever there is an active selection (i.e., the viewport is fit to a specific node, not the unselected root view). Tapping it clears the selection and animates the viewport to a "fit-all root" view, returning the editor to a neutral state from which the user can tap any frame to engage again.

Note this is semantically distinct from depth-cycling to the root container. Depth-cycle ends at "root container selected," which is still a selection. The back button ends at "no selection," which matters for tools and modes that only act when a selection exists.

Climbing the tree level-by-level is handled by depth-cycle (repeated tap on the same frame). The back button is the fast escape to the unselected root view, not a stepwise scope-up.

## Generic collision system

A single registry tracks all elements that participate in collision-based UI logic: every visible handle on every frame, plus every visible HUD notch (mode bar, breadcrumb, contextual toolbar). The registry exposes:

- `register(el, kind)` — adds an element with a kind tag (`"hud"` or `"handle"`); returns an unregister function.
- `findCollisions(el)` — returns the list of `{ el, kind, rect }` entries whose rendered viewport rect overlaps `el`'s rendered rect (excluding `el` itself).

Per-frame handle behavior is then:

1. Each handle queries `findCollisions(self)`.
2. If any collision is with a `kind: "hud"`, compute the largest overlap dimension across all colliding HUDs and apply it as `--extend`.
3. Re-query `findCollisions(self)` after the extend.
4. If anything still collides — *handle or HUD* — set a `handlesHidden` flag on the frame.
5. When `handlesHidden` is true, the frame renders no handles at all. The frame itself remains tappable; the existing tap behavior selects it, which triggers constraint-driven canvas zoom and brings handles back at a higher scale.

Because handles are at constant viewport size (see Solution), zooming in shrinks them *relative to* the frame: as scale increases, the frame's rendered size grows while handles stay put, until handles no longer collide with each other.

## Constraint detection

A node's UI "fits" at a given rendered size when, given the current handle and HUD geometry, none of its handles would have unresolvable collisions per the algorithm above. There are no magic minimum-size constants; the bound comes from the handles' actual measurements (read via `getBoundingClientRect` on a registered handle, or via documented CSS variables like `--hud-height-notch`).

The **constraint-correct zoom** for a selected node is the smallest scale factor `s` such that:
1. At scale `s`, the selected node's handles do not collide with each other or any HUD, **and**
2. The selected node fits inside the canvas viewport with the configured padding on all sides.

The viewport math computes (1) analytically from handle dimensions in viewport coords (handles are constant-size, so the minimum frame size to fit them is fixed) and (2) from the canvas viewport size minus padding. The chosen scale is the larger of the two minimums. The collision registry remains the runtime source of truth for *whether* handles are currently colliding; the analytical computation is for predicting the right scale to animate to.

## Animation

All viewport changes — pan, zoom-in, return-to-root — animate. The animation is short enough to feel responsive and long enough to convey the spatial relationship between source and destination viewport. Concrete duration and easing are an implementation choice, but the principle is: every viewport change is a single combined animation, never two separate ones.

## Out of scope

- Manual pan and zoom gestures (pinch, scroll-wheel, drag-to-pan).
- Keyboard shortcuts (Esc, arrows). The app is mobile-first; keyboard is not a baseline.
- Breadcrumb-as-primary navigation. The breadcrumb is now rendered in the top-left notch as part of the unified HUD language; it remains informational and no core interaction in this design depends on it.
- Double-tap-to-zoom (opt-in zoom on frames that already fit). Considered and dropped — it solved a problem that didn't exist given the constraint-driven model.
- Intermediate scope-up via back button. Back always clears selection and returns to fit-all root view; intermediate climbing happens via repeated tap (depth cycling).

## Architectural notes

- The viewport transform belongs at the layout root (the existing `LayoutBuilder` container or its child), implemented as a CSS `transform: scale(s) translate(x, y)`. The layout tree underneath does not need to know it's being scaled.
- The same layout root publishes the current scale as a `--canvas-scale` CSS custom property. Handles read this variable to inverse-scale themselves so they remain at constant viewport size regardless of canvas zoom.
- The collision registry lives in `AppContext` alongside the existing `observeFrame` plumbing. Handles register on mount and unregister on unmount; HUD components register their root elements on mount.
- The viewport state is derived (not stored): given the current selection and the layout dimensions, there is exactly one constraint-correct viewport. Driving the viewport from a derived value (e.g., a `createMemo` over `selection`) keeps the system stateless and removes any chance of viewport and selection drifting out of sync.
- The breadcrumb and contextual toolbar are siblings of the layout root in the DOM, each rendered inside a `Notch` (top-orientation for breadcrumb, right-orientation for the toolbar). Their positioning is handled by the existing notch CSS.
- The contextual toolbar notch contains a flex column of buttons. The notch itself renders only when at least one button is active; otherwise it is not in the DOM. The back button is the first child and renders when a selection exists. Future contextual actions append.
- The breadcrumb notch contains the existing breadcrumb segments laid out horizontally; the segments themselves stay informational.
