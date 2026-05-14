# Video playback scaling — design

Date: 2026-05-14
Status: **approved design, not yet implemented**
Supersedes the exploratory handoff in `docs/video-playback-scaling.md`.

## Problem

Every recorded clip is fully pre-decoded into in-memory `ImageBitmap`s for
its whole lifetime (`makeVideoSource` in `src/media/video-decoder.ts`), and
`loadProjectIntoState` (`src/state/projects.ts`) does this for every cell at
load. A 5-min clip fully decoded ≈ 33 GB; the app must support an unbounded
number of cells playing video simultaneously on low-end Android Chrome
(target device: Samsung Galaxy A15 / SM-A155F).

The encoded bytes already stream from OPFS — the memory blowup is 100% the
decoded-frame cache.

## How the family was chosen

The prior handoff doc concluded "pre-rendered composite is mandatory" via the
chain: *Android caps concurrent decoders → every cell needs continuous decode
→ decoder pool is dead → composite mandatory*. Re-examination found that the
load-bearing premise — the concurrent-decoder cap — was **reasoned, never
measured**, and traces to a single unverified claim from an earlier session.

The decision was instead grounded on a constraint the handoff doc never
pinned down: **target N is unbounded ("as many as fits"), requiring graceful
degradation, not a hard cap.** That filters the families structurally:

- **Composite** has O(1) playback cost in N (one video, one decode, one
  upload). Growth pressure falls on atlas resolution — cells get blurrier as
  N grows, but it never falls over. **Degrades gracefully.**
- **Streaming** has a hard cliff at N = decoder-ceiling. Softening it into a
  temporal-degradation scheduler makes it as complex as the composite and it
  is still upload-bound. A streaming-only design is a capped-N design in
  disguise — and the handoff doc already ruled "cap N" a non-starter.

Therefore the **composite is the load-bearing path** (Architecture A).
Streaming (Architecture B) is retained as an explicitly-deferred small-N
quality enhancement.

## Session deliverables

This spec defines three things: the **device probe**, **Architecture A** to
implementation depth, **Architecture B** as the deferred-enhancement sketch,
and the **decision/tuning rule** mapping probe numbers onto A's parameters
and B's future threshold.

---

## 1. Device probe

A throwaway measurement harness — its job is to **decide** tuning parameters,
not merely validate.

**Form.** `scripts/device-probe.html`, served by the existing vite dev
server, opened in Chrome on the A15 via `scripts/android-debug.sh`, results
`console.log`'d as one JSON object and tailed back over CDP with
`scripts/cdp-tail.mjs`. Lives in `scripts/`, not shipped.

**Input.** The probe first records a fresh VP8 clip on the A15 using the same
`getUserMedia` + `MediaRecorder` path as `src/media/capture.ts`, so every
measurement is against exactly what this device produces.

**Measurements.**

- **M1 — concurrent decoder ceiling.** Allocate `VideoDecoder`s one at a
  time, each kept alive and fed a keyframe, until `configure()` throws, an
  `error` callback fires, *or* per-frame decode latency spikes (the signature
  of silent software fallback — no API exposes it, so detect by throughput
  collapse). Report the count.
- **M2 — reset/reconfigure cost.** Time a `reset()` → `configure()` →
  decode-first-keyframe cycle, averaged over many iterations. Decides whether
  time-slicing one decoder across cells is viable.
- **M3 — single-decoder throughput.** Feed one decoder a long clip as fast as
  it accepts chunks at ~320×240 and ~160×120; measure decoded frames/sec.
  Divide by 30 → cells one decoder can serve in realtime.
- **M4 — `texImage2D` upload cost.** Time `texImage2D` of a frame at display
  resolution in a WebGL2 context, averaged over many calls.

**Output.** One JSON object: the four results plus device info.

---

## 2. Architecture A — atlas + temporal chunks, rebuilt from raw

### Stored representation

- Raw per-cell takes stay on OPFS unchanged (`clips/<cellId>.webm`) — the
  lossless source of truth.
- New derived artifact: the composite, stored as **temporal chunk videos**
  `composite/chunk-<i>.webm`, each C seconds of the song, independently
  decodable (chunk starts with a keyframe).
- Each chunk is an **atlas**: cells packed into fixed tiles in a grid, tile
  index assigned per `cellId` and stable. Layout-independent — GL samples
  tile rects and maps them to current layout rects, so **layout edits never
  touch the composite.**
- Manifest gains: chunk count, chunk duration C, tile resolution,
  `cellId → tile-index` map.

### Build / rebuild

On record-stop the new take spans song-time `[t0, t0+len]`. Determine which
chunks that range overlaps, mark them dirty, and rebuild each **from raw
clips**: for each cell, decode its raw clip's frames within the chunk's time
range, composite into the cell's atlas tile, encode the chunk. Cells whose
take does not cover a chunk's range get a tile filled with `Entity.color`.

This is offline and sequential — one decoder, no concurrency wall — and
because it rebuilds from raw it has **no generation loss**. `src/media/
export.ts` is already ~80% of this compositor and is the natural starting
point. Rebuild runs in the background after record-stop.

### Playback

A **chunk scheduler**: decode chunk K+1 while chunk K plays, keyframe-aligned
handoff at the chunk boundary, loop = jump to chunk 0. One `VideoDecoder`, or
a 2-decoder pool for seamless handoff (see decision rule). One `texImage2D`
per frame.

`src/webgl/renderer.ts`'s video pass changes from *N sources / N uploads* to
*1 atlas source / 1 upload / N quads sampling tile sub-rects* — a new
per-leaf `u_tileRect` attribute or uniform.

### Audio — deferred

Per-cell volume/mute (`src/clips/transport.ts`) means audio cannot be naively
baked into the atlas video. A's video path does not depend on how that
resolves, so A ships with audio still per-cell as today; **audio scaling is a
flagged follow-up spec.**

### Tuning parameters (set by the probe)

- **C (chunk duration)** — bounded by M3 (rebuild must keep up) and encode
  speed; rebuild of dirty chunks must fit comfortably in the background
  window after record-stop.
- **Tile resolution** — bounded by the atlas frame dimensions the device
  decodes well, plus M3/M4.
- **Handoff pool size (1 vs 2)** — set by M2 (see decision rule).

---

## 3. Architecture B — streaming (deferred small-N enhancement)

At record-stop, *additionally* transcode the raw take into a normalized
stream (display resolution, short fixed GOP) → `streams/<cellId>.webm`.

Below threshold **T**: a K-decoder pool does GOP-batched round-robin
decode-ahead into per-cell ring buffers (~1 GOP of frames each); N uploads
per frame. Above T: hand off to Architecture A.

**Not built now** — YAGNI until A's atlas-tile blur is actually felt in use.
But the probe sizes T (= M1) and reconfigure cost (M2) today so B is a known
quantity when it is wanted.

---

## 4. Decision / tuning rule

Unbounded N already selected A as load-bearing. The probe **tunes A** and
**sizes B**:

| Probe result | Effect |
|---|---|
| **M1** decoder ceiling | = B's threshold T. M1 ≥ ~9 → B worth building sooner; M1 ≤ 4 → stay A-only longer. |
| **M2** reconfigure cost | cheap → A uses 1 decoder with re-seek at the chunk boundary; expensive → A uses a 2-decoder handoff pool. |
| **M3** single-decoder throughput | sets max chunk duration C and atlas tile resolution (rebuild must keep up, playback must stay realtime). |
| **M4** `texImage2D` cost | confirms A's 1-upload/frame is trivially fine; quantifies B's N-upload scaling, sharpening B's threshold. |

**The one result that reopens the family question:** M1 ≥ ~16 *and* M4 cheap
→ a streaming-only design becomes viable and the family choice would be
revisited. The probe is deliberately built to be able to deliver that
surprise.

## Relevant files

- `src/media/video-decoder.ts` — `makeVideoSource`, the full-pre-decode cache (replaced).
- `src/clips/clip.ts` — `blobToClip`: demux + decode audio + pre-decode video.
- `src/components/canvas.tsx` — rAF render loop, `gatherFrames`, sync `frameAt`.
- `src/media/export.ts` — `exportSong`: the ~80%-built grid compositor A generalizes.
- `src/storage/opfs.ts` — OPFS layout; gains `composite/` (and later `streams/`).
- `src/state/projects.ts` — `loadProjectIntoState`; manifest gains composite metadata.
- `src/clips/transport.ts` — playback scheduling, per-cell gain/mute (audio sub-tree).
- `src/webgl/renderer.ts` — video pass: N-uploads → 1-atlas-upload + tile rects.
- `src/types.ts` — `Node`, `Container`, `Entity` (the layout tree).
- `scripts/android-debug.sh`, `scripts/cdp-tail.mjs` — the probe's run harness.

## Out of scope / follow-up specs

- **Audio scaling** — N `AudioBuffer`s at ~115 MB each is its own memory
  problem; baking audio interacts with per-cell volume/mute. Separate spec.
- **Architecture B implementation** — deferred until atlas blur is felt.
