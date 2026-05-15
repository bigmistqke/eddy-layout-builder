# Video playback scaling — design exploration (handoff)

Status: **exploration / grilling in progress, no decision made.**
This is a mid-conversation handoff. Read the whole thing before continuing the design.

## The problem

Today every recorded clip is **fully pre-decoded into `ImageBitmap`s held in
memory** for its whole lifetime (`makeVideoSource` in `src/media/video-decoder.ts`),
and `loadProjectIntoState` (`src/state/projects.ts`) does this for **every cell at
once**. `VideoSource.frameAt(tMicros)` is a synchronous cache lookup driven by the
rAF render loop in `src/components/canvas.tsx` (`gatherFrames`) and by
`src/media/export.ts`.

This does not scale. We want to support **many cells playing video simultaneously
on Android Chrome (smartphones)**.

## Established facts (do not re-litigate — these came from the user)

1. **The encoded bytes already stream.** `.webm` blobs live on OPFS
   (`src/storage/opfs.ts`), read lazily via `BlobSource`. The memory blowup is
   **100% the decoded `ImageBitmap` cache**, nothing else.

2. **Target: smartphones (Android Chrome), scale to "a lot of" videos playing
   simultaneously.**

3. **Platform wall:** Android gives very few concurrent hardware `VideoDecoder`
   instances (can be as low as 2–4 before errors or *silent* software fallback —
   same failure class as the VP9 hang already noted in `src/media/capture.ts`).
   There is **no API to query the limit**; a runtime probe is only a fuzzy,
   thermal/state-dependent benchmark, not a reliable number. Conclusion: the
   concurrency limit **cannot be load-bearing in the architecture.**

4. **Clips are full-length linear takes (model "i").** A cell records one
   continuous take. The song is 3–5 min ("pop videosongs"). Takes **can be
   shorter than the song** — when a take ends, that cell shows **solid color**
   (its `Entity.color`) for the rest of the song. Takes are *not* short loops.

5. **Cells are always playing — it's a jam tool.** You record new layers *over*
   the running grid and want to jam over the result. There is **no "transport
   stopped, show stills" reprieve** — the N-simultaneous-streams case is the
   steady state.

6. **Today's playback already uses zero `VideoDecoder`s** — decode happens once
   at clip-load, playback is just GL texture uploads from the bitmap cache. So
   the real design axis is **what you keep decoded and when you evict**, not
   "decode vs. don't."

## Consequences (derived, agreed)

- A 5-min clip fully decoded ≈ 33 GB of `ImageBitmap`s — **can't hold even one
  clip**, let alone N.
- N cells each needing **continuous** decode for the whole song → a decoder pool
  **does not help** (pooling needs time-slicing; here every cell needs a decoder
  the entire time). **The live decoder pool is dead for this case.**
- Therefore full-grid playback **must** go through some **pre-rendered composite**
  representation that yields N cell-streams from O(1) decoders.
- Viewport culling is **not** a useful lever — the user corrected an earlier
  wrong assumption: the full grid is visible in essentially every mode, and cells
  are always playing.

## Key idea on the table: amortize the re-render over the recording session

User's idea: **render the camera and encode the composite simultaneously.** A take
is 3–5 min of wall-clock; during it the camera produces frames and the other cells
are already being decoded+composited for display. If you *also encode* that
composite as you go, the new composite is done the instant recording stops — zero
post-render delay. Steady state = **1 decoder + 1 encoder + 1 camera**, for any N.

Pair with a **layout-independent atlas** (cells in fixed tiles, GL remaps tiles →
layout rects at draw time) → layout edits become free; only *recording* dirties
the composite.

## Open problems with the amortize-during-record idea

- **Generation loss (the big one):** each new layer decodes the previous composite
  (lossy) and re-encodes (lossy again). After many layers the early cells are
  mush. Decoding raw per-cell clips instead → back to N decoders.
- **Partial-length takes:** a 30s take into a 5-min song only live-composites
  0–30s; splicing into an existing encoded composite needs GOP-aligned segments or
  a re-encode. (Note fact #4 softens this: post-take span is just solid color.)

## The option map (we were "going wide" — user's instruction)

### Axes
- **Playback representation:** flat layout-baked composite · layout-independent
  atlas · several videos · no composite
- **Granularity:** one monolith · temporal chunks (time segments) · spatial chunks
  (cell groups) · 2D tiles
- **When rebuilt:** live during record · background after · lazy as playhead
  approaches · eager
- **Rebuilt from what:** previous composite (generation loss) · raw per-cell OPFS
  clips (lossless, but offline/sequential)

### Concrete end-to-end candidates
1. **Monolith, live-encoded during record.** Instant jam; but generation loss per
   layer, and layout/partial-take changes force whole-song re-encode.
2. **Temporal-chunked composite, chunks rebuilt from raw clips.** Song split into
   N-second independently-decodable chunks. A 30s take dirties only 1–2 chunks.
   Rebuild dirty chunks from **raw** clips → **no generation loss**, offline +
   sequential so **no decoder-concurrency wall**, rebuild ≈ seconds. Playback needs
   a chunk scheduler (decode K+1 while K plays, keyframe-aligned handoff; loop =
   jump to chunk 0).
3. **Atlas + temporal chunks.** Candidate 2 plus layout edits become free. Cost:
   cells composite at a fixed tile resolution → quality loss if a cell is shown
   much larger than its tile.
4. **Spatial sub-composites (cell groups).** K sub-composites → K decoders at
   playback (K = safe concurrency budget). Recording dirties only its group's
   timeline; no temporal chunking. Cost: spends scarce decoder budget, K-decoder
   sync, recording still re-encodes that group's whole 5-min timeline.

### Parked as non-starters / mitigations only
Live decoder pool (dead, see above) · capping N (defeats the goal) · per-cell
fps/resolution downgrade (delays the wall, doesn't break it) · cloud render
(breaks offline-first / OPFS-local model).

### Newest thread (not yet explored)
User: **"we also have containers that could maybe be used for caching."** Layout is
a tree of `Node = Container | Entity` (`src/types.ts`); `Container` has a
`direction` + `children`. A container subtree is a stable spatial grouping — it
could be the natural unit for a **spatial sub-composite / cache boundary** (a
container renders to one cached video; recording into a descendant cell only
dirties that container's cache; nested containers → hierarchical caches). This is
essentially candidate 4 with the grouping defined by the existing layout tree
instead of an arbitrary partition. **This was the live question when the session
ended — explore it next.**

## Parallel sub-tree, deliberately not opened yet

**Audio.** A 5-min stereo `AudioBuffer` ≈ 115 MB; N of them is its own memory
problem. Per-cell volume/mute (`src/clips/transport.ts` — per-cell `GainNode`s,
`setMutedCell`, `setCellVolume`) constrains whether audio can be baked into the
composite. Needs its own pass.

## Assistant's current lean (held loosely)

Candidates **2/3** are the strongest direction — temporal chunking is the one
structural choice that attacks delay, generation loss, *and* short-take locality
at once, and is the only one that makes "rebuild from raw (lossless)" cheap. The
container-as-cache idea may combine with this (temporal chunks × container
spatial groups = a 2D tile scheme).

## Where to pick up

1. Explore the **container-as-cache** idea (the open question): does the layout
   tree give us a good spatial cache boundary? How does it interact with temporal
   chunking?
2. Then converge on a candidate and weight the three pains: generation loss vs.
   rebuild delay vs. implementation complexity.
3. Open the audio sub-tree.
4. Consider writing a device probe (using the existing Android CDP harness:
   `scripts/android-repro.ts`, `tests/_android-fixture.ts`) to *validate* a
   chosen approach on a real low-end phone — not to decide.

## Relevant files

- `src/media/video-decoder.ts` — `makeVideoSource`, the full-pre-decode cache.
- `src/clips/clip.ts` — `blobToClip`: demux + decode audio + pre-decode video.
- `src/components/canvas.tsx` — rAF render loop, `gatherFrames`, sync `frameAt`.
- `src/media/export.ts` — `exportSong`: already ~80% of a grid compositor.
- `src/storage/opfs.ts` — OPFS layout (`projects/<id>/clips/<cellId>.webm`).
- `src/state/projects.ts` — `loadProjectIntoState` decodes every cell at load.
- `src/clips/transport.ts` — playback scheduling, per-cell gain/mute.
- `src/types.ts` — `Node`, `Container`, `Entity` (the layout tree).
