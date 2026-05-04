# Layout Builder — Interaction Design

**Project:** Eddy — mobile camera compositing app
**Date:** 2026-05-04
**Status:** Approved

## Context

Eddy is a mobile-first app for creating music by compositing multiple camera layers. Inspired by TikTok duet and early YouTube creative editing. The layout builder is a **dedicated view** separate from the recording view — opened by pressing `+` in the recording view, exited via a Done button.

## Goals

- Simple layouts (2–4 frames) must be achievable in a few taps
- Power users can build complex nested grids if they want to
- No ambiguity about what an action will do before you do it

## Data Model

An n-ary tree:

```
Container { direction: "horizontal" | "vertical", children: (Frame | Container)[] }
Frame      { ...camera/entity data }
```

- `Frame` is always a leaf node
- `Container` holds 1+ children in a single direction
- The root is always a Container

No changes to the existing data model are needed.

## Views

### Recording view

The main view. Shows live camera feeds composited by the current layout. Bottom toolbar: `+` (open layout builder), record, play.

### Layout builder view

Opened from `+` in the recording view. Full-screen canvas showing the layout tree. No record or play controls. Exited via **Done** in the bottom bar, returning to the recording view.

## Selection Model

Selection is a **path** — an array of indices from the root to the currently targeted node. Example: `[0, 1]` means `root.children[0].children[1]`.

### Click-to-cycle-depth

Tapping a frame cycles the selection depth:

- 1st tap on a frame → selects that frame (leaf)
- 2nd tap on the same frame → moves selection up to its parent container
- 3rd tap → moves to grandparent, and so on
- Cycles back to the leaf after reaching the root

This is the primary navigation gesture for targeting ancestor containers.

### Breadcrumb (top-left)

- Displayed top-left of the layout builder view at all times
- Derived from the current selection path: `root › col › A`
- Reflects the current depth in real time as the user taps to cycle
- Tapping a segment is a shortcut to jump directly to that level (alternative to click-to-cycle)

## Two Modes

A persistent Append/Split toggle lives in the bottom bar. Default is **Append**.

### Append mode

Adds a new Frame as a sibling inside the **currently targeted container**.

- If a leaf Frame is targeted: operates on its parent container
- If a Container is targeted (via cycle or breadcrumb): operates on that container directly
- Shows `+` handles only on the axis matching the targeted container's direction:
  - Horizontal container → left and right handles only
  - Vertical container → top and bottom handles only
- Tapping a handle inserts a new Frame at that position in the container's `children` array
- The new Frame becomes selected after insertion

### Split mode

Wraps the **currently targeted node** (Frame or Container) in a new sub-Container.

- The targeted node can be a leaf Frame or any ancestor Container (via cycle or breadcrumb)
- Shows `÷` handles in all 4 directions on the targeted node
- Tapping a handle:
  1. Creates a new Container with the direction implied by the chosen handle
  2. Places the original node and a new Frame as its two children (new frame on the side of the tapped handle)
  3. Substitutes the new Container in place of the original node in the tree
- The new Frame becomes selected after the split

## Bottom Bar (layout builder)

Notched drawer aesthetic, always visible in the layout builder view:

- **Left:** Append / Split mode toggle
- **Right:** Done button (returns to recording view)

## Key Rules Summary

| | Append | Split |
|---|---|---|
| Operates on | Targeted container | Targeted node — Frame or Container |
| Handles shown | 2 — on targeted container's axis only | 4 — all directions |
| Effect | Inserts new Frame as sibling | Wraps targeted node in new sub-Container |
| Depth navigation | Click-to-cycle + breadcrumb | Click-to-cycle + breadcrumb |
| New frame selected after | Yes | Yes |

## What Is Deferred

- **Resize** — frames share equal space in their container for now; drag-to-resize proportions is a later feature
- **Drag to reorder / nest** — reordering frames within a container and drag-based nesting are deferred
