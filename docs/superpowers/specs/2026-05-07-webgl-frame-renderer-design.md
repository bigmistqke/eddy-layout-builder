# WebGL frame renderer

## Problem

Frames are currently rendered as nested `<div>` elements: each entity is a
flex child with a colored background, the layout tree is a DOM tree, and
zoom is implemented by setting `width`/`height`/`transform` on
`canvasInner` (the root flex container) via WAAPI. This works but:

1. **Hits the browser's element-size limit at deep zoom.** When canvasInner
   grows past ~16M px (engine-dependent), the rendered DOM is clamped, and
   JS-computed sticks based on the un-clamped value place handles off-screen.
2. **Doesn't fit video.** Frames will eventually display per-frame video
   content, which is more naturally a textured GPU mesh than a styled div.

## Goal

Replace the DOM-based frame rendering with WebGL-rendered instanced quads.
Behavior is preserved exactly; only the rendering layer changes.

## Non-goals

- Replacing HUDs (Main, Breadcrumb, Contextual) — they stay DOM.
- Replacing handles (notches) — they stay DOM, repositioned via CSS
  vars on the handle overlay.
- GPU pick buffer for frame clicks — JS rect hit-test (see "Frame clicks
  (selection)"); revisit if frames stop being axis-aligned non-overlapping.
- Adding video texture support yet — schema leaves room (per-instance
  texture index) but the initial cut renders solid-color quads using the
  existing per-entity random rgb.

## Design

### Scope: rendering layer only

The state store, action handlers, viewport math, selection/handle logic,
HUDs, and tests' user-facing semantics all stay the same. The change is
how leaf entities are drawn:

- **Before:** nested `<div>` tree under `canvasInner`, each entity has
  `background: <color>` and the tree is sized via flex + WAAPI on the
  root.
- **After:** a single `<canvas>` element sized to the viewport renders
  one instanced quad per leaf entity. A vertex shader applies a viewport
  transform; the fragment shader paints the entity's color.

### Layout: pure JS

`frameRect(layout, path, canvas)` (already pure) is extended into a new
function `layoutFrames(layout, canvas)` that walks the tree once and
returns:

```ts
{
  // All leaf entities in render order (back-to-front irrelevant; opaque).
  leaves: Array<{ path: number[]; rect: Rect; color: string }>
  // The currently-selected frame's rect (the path/depth context from
  // selection) — used by the handle overlay. May be a container.
  selected: Rect | null
}
```

Per-frame rect is in canvas-local CSS pixels at the *current* scale (we
already recompute via flex math at scaled canvas size for accurate
sizing — this stays). The viewport transform (the `(x, y, scale)` from
`computeViewportTransform`) is applied in the WebGL vertex shader, not
to the canvas DOM.

### WebGL pipeline (via `@bigmistqke/view.gl`)

Single shader program. `view.gl` wires up uniforms + per-instance
attributes from a schema:

```glsl
// vertex
attribute vec2 a_corner;        // unit-quad corner in [0,1]x[0,1]
attribute vec2 i_position;      // per-instance: rect.x, rect.y in canvas coords
attribute vec2 i_size;          // per-instance: rect.w, rect.h
attribute vec3 i_color;         // per-instance: rgb in 0..1
uniform vec2 u_canvasSize;      // viewport pixels (CSS)
uniform vec3 u_view;            // (translateX, translateY, scale)
varying vec3 v_color;

void main() {
  vec2 pixel = (a_corner * i_size + i_position) * u_view.z + u_view.xy;
  vec2 clip = (pixel / u_canvasSize) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_color = i_color;
}

// fragment
varying vec3 v_color;
void main() { gl_FragColor = vec4(v_color, 1.0); }
```

`view.gl` schema:

```ts
{
  uniforms: { u_canvasSize: { kind: 'vec2' }, u_view: { kind: 'vec3' } },
  attributes: {
    a_corner: { kind: 'vec2' },                       // 4 verts × vec2
    i_position: { kind: 'vec2', instanced: true },    // N instances
    i_size: { kind: 'vec2', instanced: true },
    i_color: { kind: 'vec3', instanced: true },
  },
}
```

Per-instance buffer is a packed `Float32Array` rebuilt each frame from
`leaves`. One `drawArraysInstanced(TRIANGLE_STRIP, 0, 4, N)` call.

### Handle overlay (DOM)

Replace the current "handles are absolute children of the selected entity
div" pattern with a flat absolute-positioned overlay element parented to
the canvas wrapper:

```jsx
<div class={canvasWrapper}>
  <canvas /> {/* WebGL — frames */}
  <div class={handleOverlay} style={{
    "--x": `${selected.x}px`, "--y": `${selected.y}px`,
    "--width": `${selected.width}px`, "--height": `${selected.height}px`,
  }}>
    {/* notches positioned via top/left/width/height referencing the vars */}
  </div>
  <Breadcrumb /> <Contextual /> {/* HUDs unchanged */}
</div>
<Main /> {/* unchanged */}
```

Notch CSS swaps `right: var(--frame-padding) + var(--stick)` for absolute
positioning relative to the overlay's `--x/--y/--width/--height`. Stick
+ extend logic stays identical (it computes pixel offsets from the
selected rect, which we already provide).

### Frame clicks (selection)

Today `clickFrame(entity) → setSelection(path)` is wired via the entity
`<div>`'s `onClick`. With no entity divs, clicks land on the WebGL
`<canvas>` itself. We attach a single `onClick` on the canvas wrapper
and hit-test in JS against the same `leaves` map the renderer used:

```ts
function onCanvasClick(event: MouseEvent) {
  if (context.app.tool === null) {
    return
  }
  const rect = canvasElement.getBoundingClientRect()
  const x = (event.clientX - rect.left - viewport.x) / viewport.scale
  const y = (event.clientY - rect.top - viewport.y) / viewport.scale
  // Last-rendered leaves; hit-test by point-in-rect. Leaves don't overlap
  // (siblings under a flex container are tiled), so first match wins.
  for (const leaf of lastLeaves) {
    if (x >= leaf.rect.x && x < leaf.rect.x + leaf.rect.width &&
        y >= leaf.rect.y && y < leaf.rect.y + leaf.rect.height) {
      logAction("tap-frame", { path: leaf.path })
      context.setSelection({ path: leaf.path, depth: 0 })
      return
    }
  }
}
```

Identical observable behavior to the current `onClick`-on-entity flow.
JS hit-test wins on cost (no GPU↔CPU sync from `readPixels`) for our
small-N, axis-aligned, non-overlapping case. When we introduce masks
or absolutely-positioned frames later, those can be special-cased
inline before the rect loop (or migrated to a GPU pick buffer at that
point).
```

Identical observable behavior to the current `onClick`-on-entity flow.

### Animation: rAF tween

WAAPI is gone. A single tween runs while a viewport change is in flight:

```ts
function animateViewport(from, to, duration = 220, easing = cubicBezier(0.4, 0, 0.2, 1)) {
  const start = performance.now()
  function tick() {
    const t = easing(Math.min((performance.now() - start) / duration, 1))
    const current = lerp(from, to, t)
    render(current)            // one frame: layout + upload + draw
    if (t < 1) requestAnimationFrame(tick)
    else context.setIsAnimating(false)
  }
  context.setIsAnimating(true)
  requestAnimationFrame(tick)
}
```

`render(viewport)` is the single per-frame function: calls
`layoutFrames`, packs the instance buffer, sets uniforms, draws. Called
on every animation tick AND on every settled state change (selection,
layout, canvas resize).

`isAnimating` continues to gate the `<Show>` around handles.

### File map

- **New** `src/webgl/renderer.ts` — owns the GL context, program, buffers,
  schema (via `view.gl`). Exports `createRenderer(canvas)` returning
  `{ render(state), resize(w, h), dispose() }`.
- **New** `src/webgl/shaders.ts` — vertex + fragment GLSL strings.
- **New** `src/components/canvas.tsx` — Solid component owning the
  `<canvas>` element, wiring renderer to state via `onSettled` /
  `createEffect`, kicking off animations via the rAF tween helper.
- **Extend** `src/viewport.ts` — add `layoutFrames(layout, canvas)`
  next to existing `frameRect`. Existing functions stay (still used by
  `computeViewportTransform`).
- **Replace** `src/components/node-component.tsx` — delete; entities no
  longer have DOM presence.
- **Modify** `src/layout-builder.tsx` — render `<Canvas />` and the
  handle overlay instead of `<NodeComponent />`. Animation logic moves
  out into the canvas component or a sibling helper.
- **Modify** `src/components/notch.tsx` + `notch.module.css` — handles
  position relative to overlay CSS vars instead of parent frame.

### Test impact

Existing tests query `[data-path="..."]` to read frame rects and find
the selected frame. With entity divs gone, a parallel exposure is
needed:

- **Selected frame:** the handle overlay div carries
  `data-selected-path="..."` so `closest("[data-selected-path]")` from
  any handle still works.
- **Arbitrary frame rects:** add a `window.__layoutFrames` test hook
  that returns the same `leaves` map the renderer uses. Tests'
  `frameRect(page, path)` helper switches to reading from the hook
  instead of `getBoundingClientRect`. The hook is only set when
  `import.meta.env.DEV` is true.
- **`canvasInner` element:** gone. Tests that read its style.width /
  transform (e.g. `no-zoom-when-not-needed`) switch to reading the
  current view state via the same test hook.

## Out of scope (future iterations)

- Video texture support (plumbing left in schema; quad sampler not yet).
- WebGPU. View.gl is WebGL only as of 0.1.18.
- GPU pick buffer (readback). JS rect hit-test handles our small-N,
  axis-aligned, non-overlapping case. Revisit when masks or
  absolutely-positioned frames arrive.
- Multi-program: one shader is sufficient for solid color + textured
  quads later (uniform branch on texture-presence).
