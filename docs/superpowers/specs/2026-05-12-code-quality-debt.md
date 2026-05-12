# Code quality debt tracker

**Date:** 2026-05-12
**Status:** Working doc. Not a refactor plan. Items here may or may
not become work; the point is to be aware of them before they
compound.

**Related:** see `2026-05-11-eddy-v2-roadmap.md` "Theme 7" and
"Cross-cutting — proper error handling" for items already tracked
there; this doc only adds *new* findings.

Items already covered by the roadmap and intentionally not re-listed:
- `canvas.tsx` `<Errored fallback={null}>` swallowing gUM rejection.
- `canvas.tsx` `Drive` ref pattern in `onSettled`.
- `clips/preview.ts` function-form async signal without graceful gUM
  failure.
- The viewport-recompute effect mixing derivation and animation in
  `canvas.tsx`.

## How to read this

Items are grouped by severity. Each item:
- **Location** — `path/to/file.ts:line` (one or more)
- **What** — one-sentence description
- **Why dubious** — what's wrong / what could break
- **Possible direction** — sketch of a cleaner shape (not a binding plan)

## Bandaids / workarounds

### 1. Anchor-take "new song length" rule lives in the record handler

- **Location:** `src/hud/main.tsx:46-51`
- **What:** When the user re-records the *only* clip in the song,
  the `onRecord` handler nulls `songLength` inline before starting
  capture so the new take redefines the anchor.
- **Why dubious:** This is a piece of song-state policy ("a sole
  clip is still draft; ≥2 commits the length") sitting inside an
  event handler instead of `state.ts`. The next anchor-related
  feature (countdown, tempo, layout-over-time) will need the same
  rule and will either duplicate it or have to refactor it out.
  The user's hypothesis was right.
- **Possible direction:** Move into a `state.ts` action like
  `prepareForRecord(cellId)` that returns `{ existing, length }`
  and applies the anchor reset. The handler reads the result and
  starts capture; the rule is testable in isolation.

### 2. Auto-stop record via `setTimeout(length * 1000)`

- **Location:** `src/hud/main.tsx:76-81`
- **What:** When the song has a committed length, `onRecord`
  schedules `onStopRecording` via `window.setTimeout(..., length *
  1000)`.
- **Why dubious:** The transport is already counting `audioContext.
  currentTime` from `startedAt`; we now have a *second* time source
  (wall-clock) for record duration. They drift relative to each
  other under any backgrounding / throttling, and any future
  bars-and-beats quantisation will need the same audio-clock
  reference the transport uses. Also: silent guard via
  `captureHandle() === handle` papers over the race instead of
  cancelling the timeout in `onStopRecording`.
- **Possible direction:** Have the transport emit a "loop-boundary
  reached" callback (it already knows when one passes — see the
  `cycle` closure). `onRecord` subscribes for one tick; the
  transport drives the stop on the audio clock. Drops the wall-
  clock timer entirely.

### 3. Boot-time `void projects.init()` is fire-and-forget

- **Location:** `src/state.ts:369`
- **What:** OPFS load kicked off after `createAppState` returns,
  with no signal anywhere that "OPFS load is still pending".
- **Why dubious:** Two failure modes:
  (a) any synchronous test or interaction that runs in the gap
  between mount and load lands on the placeholder layout, then sees
  it swap underneath. Tests have a comment about this race already
  ("tests captured against initial state would otherwise race the
  async init", `projects.ts:147`).
  (b) An unhandled rejection from `init` disappears silently — OPFS
  can fail (quota, permission denied in private modes).
- **Possible direction:** Expose `projects.isLoading` for the first
  load too (it currently flips to true *inside* `init`, but the
  promise to await is internal). UI can render a "loading project"
  state; tests can `await window.__appContext.projects.ready` (a
  Promise that resolves after init completes regardless of outcome).

### 4. `isLoading` flag suppresses the auto-save effect during loads

- **Location:** `src/state/projects.ts:80, 112-129, 148-165`;
  `src/state.ts:350-364`
- **What:** A boolean signal flipped on around `loadProjectIntoState`
  and the empty-OPFS bootstrap, read by the auto-save effect to
  skip the redundant save the load would otherwise trigger.
- **Why dubious:** State setters do double duty — user actions and
  loads write the same signals; the only thing distinguishing them
  is a sentinel flag. Works today, but every new auto-save-tracked
  signal added (cellVolumes was the most recent) needs to remember
  this contract. The user's hypothesis was right.
- **Possible direction:** Two options:
  - **Action-shaped writes:** introduce `applyManifest(manifest)`
    that runs the load mutations in a batch flagged
    `{ origin: "load" }`; the auto-save effect filters on origin.
  - **Tracker signals only for user input:** `userTouchedAt` signal
    bumped by user-action setters; load writes don't bump it; the
    effect tracks `userTouchedAt` instead of the data signals.

### 5. Disconnected media-stream router relies on global `masterBus!`

- **Location:** `src/media/audio-context.ts:24, 36-67`
- **What:** `audioDestination()` returns `masterBus!` (non-null
  assertion) and `useMediaStreamOutput`/`useDirectOutput` do
  `masterBus!.disconnect()` to reroute monitor playback.
- **Why dubious:** The non-null assertions are correct today
  because `audioDestination()` is the only caller and it primes
  `audioContext()` first. But the module-level mutable state
  (`routedToMediaStream`, `mediaStreamDest`, `routingElement`,
  `context`) is implicit global singleton state; tests can't reset
  it between cases without page reload, and any second
  `AudioContext` would need parallel routing state. Disconnect-then-
  reconnect also tears down anything *else* a future feature might
  have wired into the master bus.
- **Possible direction:** Encapsulate as `createAudioRouter()`
  returning explicit handle methods; let the bus accept multiple
  taps via a `connect(node)` helper that returns a `disconnect()`
  so swapping the destination doesn't drop unrelated graph edges.

## Correctness risks

### 6. `transport.play` is async, but `transport.stop()` doesn't await it

- **Location:** `src/clips/transport.ts:106-139, 141-147`
- **What:** `play` is async (awaits `resumeAudio` then schedules
  sources). `stop()` is sync and synchronously clears `loopTimer`
  + flips state to "stopped". Pattern in callers:
  `if (state() === "playing") stop()` followed by `await
  resumeAudio()` and re-scheduling.
- **Why dubious:** Two callers can call `play()` in close
  succession (e.g. `onStopRecording` autoplays right after
  `transport.stop()` of the monitor). If the first `play()` is
  still awaiting `resumeAudio`, the second's `stop()` runs on a
  transport that hasn't yet scheduled sources; the first
  `scheduleSources` then runs *after* the stop, leaving orphan
  sources playing with no `loopTimer` registered. Won't be hit
  today because resumeAudio is fast on warm context, but it's
  fragile.
- **Possible direction:** Either make `stop()` await any in-flight
  `play()`, or guard `scheduleSources` against re-entrancy by
  bumping a generation counter and bailing on mismatch.

### 7. Loop boundary driven by `window.setTimeout(loopLength * 1000)`

- **Location:** `src/clips/transport.ts:120-138`
- **What:** `cycle` reschedules itself via `setTimeout` from wall-
  clock.
- **Why dubious:** Wall-clock drift relative to the audio clock
  accumulates over loops. At a 4s loop the visible drift is small,
  but: (a) the looping `scheduleSources(clips, audioNow.
  currentTime + 0.01)` always uses "now + epsilon" rather than
  the exact next boundary, so each loop's *audio* start has its
  own tiny clock-domain offset and they accumulate; (b) any future
  tempo / bars-and-beats / metronome feature needs sample-accurate
  boundaries. The user's hypothesis was right.
- **Possible direction:** Schedule the next pass's audio sources
  ahead of the current pass ending — `scheduleSources(clips,
  loopBoundary)` where `loopBoundary = startedAt + loopLength`.
  The boundary is exact on the audio clock; the rAF / video reset
  can still fire on a JS callback but visual drift is what we
  already have. Aligns with how DAWs handle this.

### 8. Auto-save effect fires on every cellVolume drag

- **Location:** `src/state.ts:350-364`; effect deps include
  `clips.cellVolumes()`.
- **What:** The audio slider in `audio-volume.tsx` calls
  `setCellVolume` on `onInput` (every drag step). Each step
  re-runs `saveCurrent` → `writeManifest` → OPFS write.
- **Why dubious:** Dragging a slider at 60Hz writes 60 manifests/s
  to OPFS. OPFS writes are async but not free; on mobile this
  taxes battery and possibly storage IO. Concurrent writes may
  also race — `writeManifest` is `getFileHandle({create:true})
  → createWritable → write → close` with no serialisation, so two
  in-flight saves could interleave and produce a torn manifest.
  Plain blob writes via `saveClipBlob` race-against-save in the
  same way.
- **Possible direction:** Debounce `saveCurrent` (~200ms trailing).
  Separately, serialise writes per project id via an in-memory
  queue (`writeQueue.run(id, () => writeManifest(...))`).

### 9. `frameAt` is a linear scan over all video samples

- **Location:** `src/media/video-decoder.ts:30-47`
- **What:** Synchronous lookup walks every sample until it passes
  `tSeconds`.
- **Why dubious:** O(N) per render. At 30fps over a 60s clip
  that's 1800 samples; called per cell per rAF tick. With multiple
  cells in playback, frame budget shrinks fast. Already flagged in
  Theme 3 as a memory issue, but the *lookup* is its own footgun
  even before lazy decoding lands.
- **Possible direction:** Binary search by timestamp, or maintain
  a `lastIndex` cursor (forward-only playback is the common case;
  reset on `reset()`). Constant-time amortised.

### 10. `previewTargetCellId` reads layout via a path that may no longer resolve

- **Location:** `src/state.ts:377-385`; `resolveNode` in
  `src/utils.ts:23-32`
- **What:** Memo resolves the selection's path against the current
  layout; `resolveNode` throws `"Unexpected entity node"` if the
  path crosses a non-container.
- **Why dubious:** Selection and layout are independent signals.
  A layout mutation that shortens a path (e.g. delete collapsing a
  parent) sets the next selection inline (`deleteSelection`), but
  during the brief window between `setApp(...layout)` and
  `setApp(...selection)` — and especially under any future op
  that mutates layout without coordinating selection — the memo
  re-runs against the new layout with the old path and throws.
  Stale paths in OPFS manifests are a similar exposure on project
  open.
- **Possible direction:** `resolveNode` returns `null` for an
  unresolvable path; memo returns `null`. Or co-locate layout +
  selection in a single store mutation pattern so they update
  atomically.

## Design smells

### 11. `canvas.tsx` `recomputeViewport` mixes derivation, DOM reads, side effects, and a debug `console.log`

- **Location:** `src/components/canvas.tsx:263-319`
- **What:** A single function reads `wrapperElement.getBoundingClientRect`,
  computes a viewport transform, computes handle extends/sticks,
  calls `context.setViewport` + `context.setSelectedHandlesState`,
  logs a perf line, and returns the transform for the animation
  tween.
- **Why dubious:** Roadmap Theme 7 already flags
  "viewport-recompute effect → memo". Beyond that:
  - The `console.log` (line 294) is permanent dev instrumentation
    masquerading as runtime code. There's a `// eslint-disable`
    directive papering over it.
  - DOM reads inside an untrack scope mean tests can't drive this
    without a mounted DOM.
  - `setSelectedHandlesState` is fed from the same computation —
    handle layout could be a `createMemo` that reads viewport +
    rect; the effect could be pure animation.
- **Possible direction:** Split into:
  - `useViewportTransform(): Memo<ViewportTransform>` — pure
    function of layout, selection, tool, canvasRect, hudRects
    (all reactive signals; canvasRect tracked via ResizeObserver
    signal).
  - `useSelectedHandlesGeometry()` — memo over viewport + frame.
  - The animation `createEffect` reads the viewport memo and only
    runs the tween.
  Drop the perf log behind a flag (or remove it).

### 12. `canvas.tsx::drawAt` directly writes CSS variables for both selected-rect and preview overlays

- **Location:** `src/components/canvas.tsx:234-260`
- **What:** Inside `drawAt`, after the GL render, the function
  manually sets six (selected) and another four (preview) CSS
  custom properties on `wrapperElement` for the handle overlay
  and camera-loader.
- **Why dubious:** Layout state derived per-frame from JS into
  CSS variables is a leaky bridge. Two distinct overlay
  consumers each need to know about the four custom-prop names
  the renderer happens to publish; adding a third (e.g. record-
  indicator over a cell) means writing more `setProperty` calls
  in `drawAt`. The handle CSS lives in a different module from
  the var producer.
- **Possible direction:** A typed `OverlayPositioner` API:
  `overlay.set("selected", rect)`, `overlay.set("preview", rect)`.
  Internally it sets the variables; consumers reference the API,
  not the prop names. Or use absolute-positioned elements driven
  off Solid signals — they're already mounted under the wrapper
  via `<Show>`.

### 13. `Math.random()`-derived entity color stored on the layout tree

- **Location:** `src/state.ts:67-73`; `src/state/projects.ts:59-65`
- **What:** Each new entity gets `color: "rgb(150..250, ...)"`
  baked into the node, serialised in the manifest, parsed back to
  RGB in `renderer.ts::parseColor`.
- **Why dubious:** Three smells:
  - Stored *as a CSS string* and re-parsed per render via regex.
  - Two independent `freshLayout`/`createEntity` functions both
    generate this color the same way (duplication).
  - Non-determinism on the data model — two projects with the
    same shape have different colors, and the value can't be
    chosen, themed, or palette-cycled centrally without a
    migration.
- **Possible direction:** Store a `colorIndex: number` on the
  entity; resolve at render via a palette array. Manifest stays
  stable across theme changes; tests can assert color by index.

### 14. `pickMimeType` throws on unsupported browser; nobody catches

- **Location:** `src/media/capture.ts:15-22`, called inside the
  synchronous `startCapture` invoked from `onRecord` event handler.
- **Why dubious:** Throw happens inside a `setCaptureHandle(handle)`
  pipeline with no try/catch above. The user sees a broken record
  button on any browser that lacks the three preferred mime types;
  the Solid event handler propagates the error uncaught. This is a
  "real users with denied permission" sibling of the gUM gap the
  v2 roadmap already calls out.
- **Possible direction:** Surface as `cameraStatus` / capture
  status — alongside the `preview.ts` graceful-failure rework in
  the v2 error-handling cross-cut. Mention there.

### 15. Dead module: `src/media/extract-audio-channels.ts`

- **Location:** `src/media/extract-audio-channels.ts` (entire file)
- **What:** Exports `extractAudioChannelsFromAudioData`. Not
  imported anywhere in `src/` or `tests/`.
- **Why dubious:** Dead code accumulates rot — divergent style
  (`'single quotes'` and trailing comments at the top), implies a
  dependency the renderer never developed. Future grep noise.
- **Possible direction:** Delete it. If a future audio decode path
  needs it, re-introduce from git history with whatever style the
  rest of `src/media` has settled into.

## Nits

### 16. `tests/helpers.ts::activateTool` reads `app.tool` via two CDP round-trips

- **Location:** `tests/helpers.ts:206-214`
- **What:** Each `activateTool` call does up to two `page.
  evaluate(() => window.__appContext?.app.tool)` round-trips plus
  one or two clicks.
- **Why dubious:** Tests are already slow under the `vite build &&
  vite preview` workflow (Theme 6). Each CDP eval is a few ms; in
  a 20-step `runActions` replay these add up. Necessary today
  because `set-tool-{tool}` is a *toggle*; the helper has no other
  way to know the starting state. The user's hypothesis was right.
- **Possible direction:** Expose `setTool(tool)` (idempotent set,
  not toggle) on `window.__appContext` for test use, gated to
  `import.meta.env.DEV`. Tests call the explicit setter; no eval
  round-trips. This dovetails with Theme 6's "programmatic clip
  injection" idea — both want a test-only context surface.

### 17. Duplicate viewport-identity / zero-direction record constants

- **Location:**
  - `src/viewport.ts:18` — `IDENTITY_VIEWPORT`
  - `src/media/export.ts:16` — `VIEWPORT_IDENTITY`
  - `src/components/canvas.tsx:30` — `ZERO_BY_DIRECTION`
  - `src/state.ts:75` — `ZERO_BY_DIR`
- **What:** Same constants defined in multiple files under
  different names.
- **Why dubious:** Mild — won't cause a bug, but the next refactor
  that changes the shape of `ViewportState` will require chasing
  duplicates. The `ZERO_BY_DIR{,ECTION}` pair is the worse offender
  because two slightly different names invite "are these actually
  the same?" reading time.
- **Possible direction:** Single export from `viewport.ts`; import
  in both callers.

### 18. Inconsistent quote style + comment style in `extract-audio-channels.ts`

- **Location:** `src/media/extract-audio-channels.ts` (whole file)
- **What:** Single quotes throughout, JSDoc-style header block,
  inline comments. Rest of `src/` uses double quotes and Prettier-
  standard comments.
- **Why dubious:** If kept (see item 15), would fail any future
  format check. Almost certainly a copy-paste from an older
  codebase.
- **Possible direction:** Bundled with the "delete dead file" call
  in item 15.

### 19. `clipStore.cellIds` and `clips` map can drift

- **Location:** `src/clips/store.ts:33-60`
- **What:** `cellIds` (signal) and `clips` (plain record) are
  updated together in `setClip`/`clearClip`/`clearAll`, but
  nothing structurally forces them to agree. `setClip` does
  `if (!cellIds().includes(cellId))` — an O(N) read in a setter
  to maintain that invariant by hand.
- **Why dubious:** The "set of recorded cells" is one piece of
  state expressed as two; future call sites can update one without
  the other (`disposeClip(existing)` then forget to update
  `cellIds`, say).
- **Possible direction:** Derive `cellIds` as a memo over the
  reactive map keys — but the map is intentionally non-reactive
  for WebCodecs reasons (`store.ts:11-13`). Alternative: a single
  signal of type `Map<string, Clip>` exposed via a frozen accessor;
  membership is `clips().has(id)`, iteration is `clips().values()`.
  Identity-stable read of an entry stays cheap.
