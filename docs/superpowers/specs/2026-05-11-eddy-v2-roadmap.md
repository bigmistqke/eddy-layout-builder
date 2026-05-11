# eddy v2 — roadmap

**Date:** 2026-05-11
**Status:** Draft. Captures the v2 surface that emerged from MVP work. Not yet broken into individual specs.
**Predecessor:** `2026-05-11-eddy-mvp-design.md` (MVP, shipped).

## How to read this

A v2 themed backlog, not a single spec. Each item is sized for a future round of brainstorming → spec → plan. Items are grouped by theme; within a theme, ordering reflects rough priority but isn't binding. Some items unlock others (noted under "Depends on").

## Locked-in v2 items

Everything listed under "Explicitly out of MVP" in the MVP spec carries forward. Reproduced here so this document stands alone:

- Time-as-composition (multi-clip per cell, layout changes over time, automation)
- Trim, nudge, ripple, any non-destructive editing
- Effects, EQ, per-voice levels, pan
- Tempo, metronome, click-track, bars/beats
- Camera/mic device picker, multi-camera, screen capture, file import
- OPFS persistence, atproto, sharing, accounts, social
- Undo/history
- Landscape orientation
- Desktop polish
- Export to mp4

Plus items that emerged from MVP build/smoke testing (described in detail below):
- Countdown before recording
- Pre-render/bounce for scaling beyond 4–9 voices
- Mobile UX polish: device picker, camera switch, orientation rotation
- Test infra: programmatic clip injection bypassing gUM/MediaRecorder
- Code cleanup: address pre-existing flake risk areas (catalogued below)

---

## Theme 1 — Export + bouncing

The single biggest v2 item. Without it the MVP can produce a song but can't share it. Bouncing shares the same machinery and unlocks performance headroom, so both arrive together.

### Export to mp4

Capture the synced grid as a single muxed file the user can save.

- **Pipeline:** WebGL composite (already exists) → `VideoEncoder` → audio mix bus (already exists) → `AudioEncoder` → mediabunny `Output` + `Mp4OutputFormat`.
- **Render mode:** off-clock, not real-time. Render as fast as the encoders accept. Progress UI required.
- **Trigger:** explicit "export" button in the HUD. Produces a downloadable Blob.
- **Mediabunny APIs to lean on:** `Output`, `Mp4OutputFormat`, `MediaStreamVideoTrackSource` / `MediaStreamAudioTrackSource` (1.42 added these), `Conversion` (1.42 added fan-out, useful for variants if we ever ship multiple resolutions).
- **Depends on:** nothing — pipeline is in place.

### Freeze / bounce

DAW-style. Compose a subset of cells into a single audio+video clip in-session. Plays back as one decoder + one source, freeing memory and decoder slots.

- **Pipeline:** identical to export, but result lands as a new `Clip` in the store instead of a file.
- **Architectural seam:** factor a `composite(clips, layout): Promise<Clip>` function once; export wraps it with file output, bounce wraps it with clip injection.
- **Why now:** the 4–9 voice ceiling will hit users; bouncing is the standard solution. Also unlocks time-as-composition (each layout-state can be bounced and stitched).
- **Depends on:** Export pipeline (shared).

---

## Theme 2 — Composition

The "more than one take per cell" axis. Each item adds expressivity without changing the song-as-grid model.

### Countdown before recording

Tap record → 3-2-1-go visible in the target cell → recording starts.

- **Why:** lets the user prepare; smooths out the moment between "press button" and "start performing". Especially useful for overdubs where you need to feel the existing voices for a beat first.
- **Implementation sketch:** add a `Transport.countdown(seconds)` mode that plays existing voices but doesn't capture yet; emits ticks (audible click? visible overlay?) until the count reaches zero, then transitions seamlessly into recording.
- **Open question:** click track during countdown — audible (metronome) or silent visible-only? Probably audible if tempo exists, silent otherwise.
- **Depends on:** ideally lands after tempo (so the countdown can sync to bar boundaries), but works standalone.

### Time-as-composition

Multiple clips per cell, arranged in time. Or the layout itself changes over time.

- **Two flavours, pick one or both:**
  - **Stacked clips per cell:** cell has an array of `(clip, startTime, duration)` instead of a single clip. Playback iterates the array.
  - **Layout-over-time:** each layout-state has a duration; song is a sequence of layout-states. Bouncing each state to a clip + stitching is the implementation.
- **Spec-level decision:** which mechanic is the primary user story? "Add a verse to my chorus" vs. "Switch the camera arrangement between sections". Worth grilling before designing.

### Re-record with start point

Currently re-record replaces the whole clip. Could be useful to re-record from a specific offset into the song.

- **Mostly UX:** start the new recording at a chosen position; the resulting clip is overlaid on the old one from that point, or replaces a region of it.
- **Depends on:** tempo + bar positions (so users can say "re-record from bar 2"), OR non-destructive trim (so the offset is editable later).

### Tempo / metronome / click track

Bar-and-beat grid. Records can be set to a length-in-bars instead of length-in-seconds.

- **Touches:** songLength (replace with `bars × beats × tempo`), record-stop quantisation, countdown timing, future trim quantisation.
- **Open question:** does the user set tempo before recording, or detect it from the first take? Both are plausible.

### Trim / nudge / non-destructive edits

Adjust clip in/out points without re-decoding. Drag a clip's start/end.

- **Implementation:** per-clip `{ trimIn, trimOut }` seconds; `transport.play` schedules `source.start(when, trimIn, duration - trimIn - trimOut)`. Video lookup adds `trimIn` to position.
- **Spec-level:** is this a v2 feature or v3? It's a lot of UX surface (drag handles, snap-to-beat) for relatively few wins. Maybe leave for v3 and v2 sticks to record/replace semantics.

### Per-clip volume (mixing)

A per-cell level slider so users can balance recordings against each other.

- **State:** per-clip `volume: number` (default 1.0). Lives on the Clip or alongside in project manifest so it persists.
- **Wire:** transport already owns a `GainNode` per cell (built for the preview-mute feature). Combine `volume * (muted ? 0 : 1)` into that node's gain value, with a short ramp on user-driven changes to avoid clicks.
- **UI direction (settled 2026-05-12):** everything stays attached to the canvas. The main HUD's Edit toggle reveals three tools — split / append / **audio** — in the contextual bar. Selecting `audio` swaps the preview camera for a per-cell vertical slider on the right edge of the selected cell. Empty cells get a disabled slider; the breadcrumb is hidden in audio mode (containers don't carry audio at this layer — see v3 note below).
- **Depends on:** nothing — pure additive feature on top of the existing per-cell gain infrastructure.
- **v3 idea — container-as-bus:** in audio mode, selecting a container could expose a bus-level gain that scales every child clip together. Lets users group-fade a section without touching individual cell sliders. Defer until composition (time-as-composition / sections) lands so we know what containers represent musically.

### Per-clip offset (recording-lag compensation)

Recorded audio lands slightly later than the user pressed record (mic + browser latency, often 50–200ms). Users hearing the result want to nudge a clip earlier to sync.

- **State:** per-clip `offsetSeconds: number` (default 0). Negative = play earlier than scheduled t=0; positive = later. Persist via manifest.
- **Wire:** transport schedules audio via `source.start(when - offset, max(0, -offset))` (handles both directions cleanly). Video frame lookup shifts by `offset` too so audio + video stay locked together.
- **UI:** ±10ms nudge buttons per cell, plus a "reset" affordance. Optionally a song-wide "calibrate latency" flow that prompts a clap, measures the delta from a known click, and applies as a default offset to future records.
- **Open question:** is this strictly a per-clip property, or should there also be a device-wide latency baseline that all new records inherit? Probably both — the device baseline is recorded once and applied automatically; per-clip offset is the fine-tune knob.
- **Depends on:** nothing structural; needs UI surface design.

---

## Theme 3 — Performance + scaling

### Pre-decoded sample memory

Currently `makeVideoSource` pre-decodes every `VideoSample` for the clip into memory. Fine for short clips at small resolutions; will not scale.

- **Move to lazy decoding via `VideoSampleSink.samples()` iterator** with a small look-ahead window. Mediabunny pre-decodes a few frames ahead based on consumer speed — we can rely on that.
- **Frame-ring eviction** (the design originally sketched in the MVP plan) becomes load-bearing here.
- **Depends on:** measurement. If MVP feels fine at typical use, defer.

### Texture upload optimisation

Renderer's video pass does per-leaf `texImage2D` upload + draw. For 4–9 cells this is fine. Beyond that, switch to `TEXTURE_2D_ARRAY` (one upload of all frames, N draws sharing the same bind).

- **Depends on:** measurement against real mobile devices.

### Mobile profiling pass

We haven't actually run eddy on a real Android phone yet.

- **Concrete items:**
  - HTTPS for local testing on LAN (`vite-plugin-mkcert`)
  - Camera permission flow on real device
  - Audio context resume on first touch
  - Power/thermal under sustained record + playback

---

## Theme 4 — Mobile + platform

### Front/rear camera switch

The default `getUserMedia({video: true})` doesn't let you choose. Most phones default to back camera. Music apps typically default to front.

- **Implementation:** `getUserMedia({video: {facingMode: "user"}})`. Add a toggle in the HUD to switch facing.
- **Mid-record:** can't change facing on an active recording; toggle only between recordings.

### Camera + mic device picker

`navigator.mediaDevices.enumerateDevices()` lists everything; UI shows a dropdown.

- **Probably bundled with the facing toggle.**

### Video orientation / rotation metadata

Front-camera captures on Android frequently carry rotation metadata. `VideoDecoder` does NOT auto-rotate. We saw warnings during MVP smoke testing.

- **Fix:** read `VideoSample.rotation` (mediabunny exposes this), apply in the renderer's video vertex shader.
- **Touches:** `VIDEO_VERTEX_SHADER` — adds a rotation matrix uniform per cell.

### Landscape orientation

MVP is portrait-only. Landscape is conceptually clean but adds layout-builder edge cases (wider-than-tall cells).

### Desktop polish

Mouse/keyboard, larger viewport. Lower priority — design target stays mobile-first.

---

## Theme 5 — Persistence + sharing

### OPFS persistence

Save the in-progress song to OPFS so a refresh doesn't lose it.

- **Storage shape:** per-cell encoded blob + a JSON manifest describing the layout tree.
- **Reload flow:** read manifest → reconstruct layout state → `blobToClip` each cell's blob (cached, so cheap on warm starts).
- **Depends on:** export pipeline (we already produce the encoded blobs at record time, so storage is straightforward).

### atproto + lexicons

The third leg of the eddy stack per the original pitch. Songs become first-class records on atproto; collaboration, sharing, browsing other people's videosongs.

- **Lexicons:** the deferred `packages/lexicons` directory from eddy-1.0 has a starting point.
- **Spec-level questions:** what's the record shape? Per-song record with embedded clip blobs (or refs), or a record per cell? How does pairing/duetting work (one user records a voice and shares the half-finished song)?
- **Depends on:** OPFS (so we have a known local representation to serialise).

---

## Theme 6 — Test infra cleanup

### Programmatic clip injection

The `mockGetUserMedia` + MediaRecorder + mediabunny chain is a lot of moving parts for tests that just want to verify "the cell has a clip". Add a test-only `__appContext.clips.injectFixture(cellId)` that creates a `Clip` from a pre-decoded fixture without going through the recorder.

- **Wins:** faster tests, no flake risk from MediaRecorder/decode timing.
- **Cost:** test-only code in production bundle (gated by `import.meta.env.DEV`).

### Eliminate the production-build hack

Currently `pnpm test` runs `vite build && playwright test` against `vite preview` to avoid dev-server flake. Sound, but slow (~2s build on every test invocation). When v2 starts, revisit whether HMR-driven dev tests can be made deterministic — possibly via `optimizeDeps.include` for mediabunny/view.gl so the first-touch optimization doesn't happen mid-test.

---

## Cross-cutting — adopt Solid 2.x `action()` for v2 mutations

Solid 2.x's `action(fn)` wraps an async mutation and gives you:
- pending state via `useSubmissions(action)` (replaces manually-managed loading signals)
- error propagation to `<Errored>` boundaries (replaces try/catch + custom state)
- `refresh(source)` to invalidate derived reads after the mutation lands
- optional optimistic UI via `createOptimistic` / `createOptimisticStore`

MVP intentionally uses plain async event handlers — the win was too small to justify the refactor when error UI and pending UI weren't built yet. v2 changes that. Adopt `action()` for: **export**, **bounce**, **file import**, **atproto publish**, and possibly **record** if/when we add a visible "decoding…" indicator between record-stop and clip-lands.

Don't go retro and rewrite the MVP handlers — keep them as-is until they're touched for a feature that needs the action machinery.

---

## Cross-cutting — proper error handling

Surfaced while debugging the OPFS-feature test breakage (2026-05-11). Today the app has *no* application-level error boundary; the only `<Errored>` is a defensive `fallback={null}` in `canvas.tsx` swallowing the camera-loader's `preview.stream()` rejection. Everything else propagates uncaught — corrupts sibling JSX renders if the throw happens in a tracked read, silent if it happens in an event handler.

Symptoms we hit:
- Tests not calling `mockGetUserMedia` saw `getUserMedia` reject with browser-native `NotSupportedError`. Solid wrapped it as `StatusError` (minified `io`), propagated past the `<Loading>` boundary (which only catches `NotReadyError`), and broke the handle-overlay's reactive update — `data-selected-path` stayed empty even though `selection.path` had updated. Tests timed out waiting for the overlay.
- Worked around in two ways: added a Playwright launch flag for a Chromium fake camera; wrapped the camera-loader `<Loading>` in `<Errored fallback={null}>`. Both are bandaids — the underlying gap is real.

What v2 should do:
- **Restore graceful gUM handling in `preview.ts`** — catch `NotSupportedError` / `NotAllowedError`, surface as a `cameraStatus` accessor (`ready | pending | unavailable | denied`), let consumers render an appropriate state. Don't swallow non-permission errors.
- **App-level `<Errored>` boundary in `App.tsx`** with a real fallback ("Something went wrong, retry?" with `reset()`). Catches truly unexpected throws.
- **Toast / status HUD surface** for non-fatal errors (export failed, save to OPFS failed, atproto publish rejected). Adopting `action()` for those mutations (see above) gives a natural place to plug it in — pending state + error state come from the same primitive.
- **Per-call-site try/catch in event handlers** that read async signals via `untrack` (`onRecord` reads `untrack(context.preview.stream)`; if pending or errored, throws).

Don't try to do all of this in one PR. The order that makes sense:
1. `preview.ts` graceful failure (smallest, biggest win for tests + real users with denied permission).
2. App-level `<Errored>` boundary with a default fallback.
3. Toast/status surface — only when the first non-fatal action (export/save) needs it.

---

## Theme 7 — Code cleanup catalogued during MVP

Each is a small focused PR.

- **Viewport-recompute effect → memo.** `canvas.tsx`'s layout-animation `createEffect` mixes derivation (writes `setViewport` + `setSelectedHandlesState`) with imperative animation triggering (rAF tween). Per the project's "effect-apply is for side effects, not state syncing" rule, the derivation should be a `createMemo`; the effect should only run the tween. Blocked on lifting `wrapperRect` and `hudRects` into reactive signals (currently DOM-read each compute via `getBoundingClientRect`).
- **Audio rotation metadata:** read it once at clip-load, store on `Clip`, apply in renderer.
- **`canvas.tsx` `Drive` ref shape:** the ref pattern works but is one of the more intricate parts of the codebase. If a clearer pattern (signal-based with `runWithOwner` for the rAF callback?) emerges, consider refactoring.
- **`mediabunny` deprecated sync getters:** none used today, but if any creep in, replace with `await track.getCodec()` etc. (1.42+ deprecation).
- **`AudioBufferSink` chunk concatenation:** current `decodeToAudioBuffer` allocates the output buffer eagerly. For very long clips (v2 territory) consider streaming into a growing `AudioBuffer` or skipping the concat by scheduling each chunk separately.

---

## Themes NOT planned

Recorded here so future-us doesn't re-debate them:

- **Effects rack** (filters, reverb, EQ): out of scope for v2. The videosong genre doesn't lean on this.
- **MIDI input**: out of scope. Use the camera+mic; v2 stays vocal/acoustic.
- **Cloud rendering** for export: client-side WebCodecs is fast enough for MVP-sized songs; revisit only if exports exceed a few minutes.
- **Multiplayer / live-collab**: atproto sharing is the social path; live multiplayer isn't planned.

---

## Open questions before v2 starts

1. **Sequence of themes**: export first (so users can save), or composition first (so the product has more depth before sharing)? Probably export — every user needs it; only some need bars-and-beats.
2. **Time-as-composition flavour**: per-cell clip stack, layout-over-time, or both? Affects the song-as-data shape.
3. **Tempo before or after time-as-composition**: tempo unlocks countdown-on-beat and trim-snap, but isn't strictly needed for stacked clips. Decide before designing either.
4. **Mobile-first vs mobile-only**: MVP is mobile-only. Does v2 actively support desktop, or just "not break"?

---

## When v2 starts

Pick one theme. Run brainstorming → spec → plan → execute. Don't try to scope all of v2 in one design pass — it's too broad. Use this document as the menu, not the recipe.
