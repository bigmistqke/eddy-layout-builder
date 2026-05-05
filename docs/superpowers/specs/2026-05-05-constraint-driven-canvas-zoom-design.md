# Constraint-driven canvas zoom

## Problem

In layout mode, every frame renders UI inside it — currently the four notch handles for splitting and circular edge buttons for appending. As the user splits the layout further, individual frames shrink. Below a certain size, this UI no longer fits in the frame: handles overlap each other, edge buttons collide with notches, and the experience breaks down.

The constraint is general, not handle-specific: **every frame in layout mode must have enough rendered space to display its in-frame UI.** New UI added later (labels, inline controls) inherits the same constraint.

## Solution

The canvas (the layout root) is scaled and translated so the **selected node** is rendered at exactly the size it needs to fit its UI — with a configurable padding around it inside the viewport. The transformation is purely visual; the underlying layout tree is unchanged. Selecting a smaller node zooms in; selecting a larger one zooms out.

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

### Back button

A floating contextual toolbar sits at the top right of the canvas. It is reserved for canvas-context actions; future contextual buttons stack vertically below the first one.

The first occupant is the **back button** — the supplied left-arrow SVG. It is visible whenever there is an active selection (i.e., the viewport is fit to a specific node, not the unselected root view). Tapping it clears the selection and animates the viewport to a "fit-all root" view, returning the editor to a neutral state from which the user can tap any frame to engage again.

Note this is semantically distinct from depth-cycling to the root container. Depth-cycle ends at "root container selected," which is still a selection. The back button ends at "no selection," which matters for tools and modes that only act when a selection exists.

Climbing the tree level-by-level is handled by depth-cycle (repeated tap on the same frame). The back button is the fast escape to the unselected root view, not a stepwise scope-up.

## Constraint detection

A node's UI "fits" at a given rendered size when:

```
nodeWidth  ≥ MIN_NODE_WIDTH
nodeHeight ≥ MIN_NODE_HEIGHT
```

Where the minimums are derived from the worst-case UI footprint at that node: handle width on left + handle width on right + minimum interior, and the same vertically. Concrete values come from `frame.module.css` and the existing handle dimensions; they should be defined as a single source of truth (e.g., a constant exported from a shared module) so the constraint detection and the rendered UI can never drift apart.

The **constraint-correct zoom** for a selected node is the scale factor `s` such that:
1. The selected node's rendered size at scale `s` is at least the minimum (so its UI fits), and
2. The selected node fits inside the canvas viewport with the configured padding on all sides.

In practice these resolve to one zoom level per node: enough to satisfy the minimum, but no more than necessary to keep the node fully framed. Larger nodes settle at lower zoom levels; smaller nodes at higher.

## Animation

All viewport changes — pan, zoom-in, return-to-root — animate. The animation is short enough to feel responsive and long enough to convey the spatial relationship between source and destination viewport. Concrete duration and easing are an implementation choice, but the principle is: every viewport change is a single combined animation, never two separate ones.

## Out of scope

- Manual pan and zoom gestures (pinch, scroll-wheel, drag-to-pan).
- Keyboard shortcuts (Esc, arrows). The app is mobile-first; keyboard is not a baseline.
- Breadcrumb-as-primary navigation. The breadcrumb may continue to exist as informational UI but no interaction in this design depends on it.
- Double-tap-to-zoom (opt-in zoom on frames that already fit). Considered and dropped — it solved a problem that didn't exist given the constraint-driven model.
- Intermediate scope-up via back button. Back always clears selection and returns to fit-all root view; intermediate climbing happens via repeated tap (depth cycling).

## Architectural notes

- The viewport transform belongs at the layout root (the existing `LayoutBuilder` container or its child), implemented as a CSS `transform: scale(s) translate(x, y)`. The layout tree underneath does not need to know it's being scaled.
- The constraint detection runs on the *currently selected node's* rendered size — entity or container. It does not run on every frame; only the selected node matters. The shared `ResizeObserver` in `App` already provides the measurement plumbing for this.
- The viewport state is derived (not stored): given the current selection and the layout dimensions, there is exactly one constraint-correct viewport. Driving the viewport from a derived value (e.g., a `createMemo` over `selection`) keeps the system stateless and removes any chance of viewport and selection drifting out of sync.
- The back button is a sibling of the layout root in the DOM, positioned absolutely. It listens to whether a selection exists; when there is one, it renders.
- The top-right contextual toolbar is a slot — a flex column container — that the back button is the first child of. Future contextual actions append.
