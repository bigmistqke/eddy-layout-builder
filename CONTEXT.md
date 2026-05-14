# Context

Domain language for eddy. Keep terms here consistent with the code.
One entry per concept: the term, what it means, and where it lives.

## Layout

- **Layout tree** — the recursive `Node` structure (`src/types.ts`). The
  root of the composition; starts as a single Entity, grows into
  Containers as the user splits/appends.
- **Container** — a `Node` with a `direction` and children. Tiles its
  children edge-to-edge along its axis (flex `flex: 1`, no gap, no
  padding — see ADR-0001).
- **Entity** — a leaf `Node`: an id and a colour. The thing a clip
  records into.
- **Frame** — the computed rect of a Node at a given canvas size. Not a
  stored field; produced by the frame-layout pass.
- **Leaf** — a Frame whose Node is an Entity. What the renderer, export,
  and breadcrumb minimap paint.
- **Frame-layout pass** — the single pure walk that turns
  `(layout tree, canvas size)` into Frames. Lives in `src/viewport.ts`
  as `frameRect` (single path → one rect) and `layoutFrames` (whole
  tree → leaves + selected rect). Closed-form: with no gap/padding,
  `frame(scale s) === frame(1) × s`, so no iteration is needed.
- **Cell** — user-facing name for an Entity that holds (or will hold) a
  clip. Recording/transport code says "cell"; layout code says
  "entity". Same leaf, two vocabularies — see candidate-list note.

## Selection & handles

- **Selection** — `{ path, depth, preview }` (`src/types.ts`). `path`
  locates a Node; `depth` collapses a tail of it to the targeted node.
- **Handle** — a directional affordance on a selected Frame's edge that
  performs a split or append.
- **Extend** — per-direction px a handle's notch grows *outward* so its
  visible tip clears a HUD floating over the frame. Obstacle: a HUD
  rect. (HUDs collinear with the handle's escape axis can't be cleared
  this way — that triggers zoom-to-fit instead.)
- **Stick** — per-direction px a handle is pulled *inward* to stay
  inside the canvas viewport when the frame has overflowed an edge.
  Obstacle: the canvas boundary. Computed before extend (stick on the
  post-transform rect, extend on the resulting stuck rect).
- **Frame-affordances** — the single pure composition that turns
  `(layout, path, canvasSize, hudRects)` into
  `{ viewport, handles: { extend, stick } }`. Owns the fit-scale
  decision and the extend/stick pipeline; `viewport.ts` keeps only the
  geometry primitives it composes.

## Playback

- **Clip** — a recorded take for a cell: decoded audio buffer + video
  source + duration. `blobToClip` (the decode primitive) turns a raw
  recorded blob into a Clip.
- **Clip intake** — turning a blob into a persisted, decoded, staged
  Clip. Owned by `projects`: `persistRecording(cellId, blob)` for fresh
  recordings (blob to disk *before* staging in memory), and the
  project-load path for blobs already on disk. Both share a private
  `intakeClip` (decode + store) tail. The project manifest is still
  written by the background auto-save effect, not by intake.
- **Transport** — the reactive playback shell: owns `state` /
  `startedAt` signals, `position()`, and the loop-timer `cycle`. Holds
  no Web Audio nodes; delegates scheduling to the AudioScheduler.
- **AudioScheduler** — the imperative Web Audio adapter behind
  Transport: owns sources, per-cell gain nodes, mute/volume, and the
  audio clock (`now()`). The only module that touches
  `media/audio-context`. No reactive state.

- **Preview** — the live camera feed for the selected cell. Owns a
  persistent `<video>` element and a `state()` signal — a 4-state
  union: `idle` (not requested / disabled), `pending` (gUM in flight),
  `ready` (`{ stream }`), `error` (`{ error }`). `enable()` runs
  `getUserMedia` and drives the transitions; `disable()` returns to
  `idle`. No async-signal trickery — `error` is distinct from `idle`,
  which is what a "camera blocked" affordance needs.

## HUD

- **HUD** — an edge-anchored overlay panel above the canvas (main bar,
  breadcrumb, menu, contextual bar). Identified only by its
  `orientation` (long axis) — there is no per-HUD "kind"; the viewport
  math only needs each HUD's rect + orientation.
- **HUD registry** — `state.ts` holds every mounted HUD element in a
  `Map<HTMLElement, HudOrientation>`, watched (along with the canvas
  viewport element) by a single `ResizeObserver`. The observer rebuilds
  `hudRects` — the reactive `HudRect[]` consumed by frame-affordances
  math. Replaces the old pull-style `computeHudRects(canvasRect)`.
