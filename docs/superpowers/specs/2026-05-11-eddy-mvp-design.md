# eddy MVP — design

**Date:** 2026-05-11
**Status:** Approved, ready for implementation planning

## Concept

eddy is a mobile-portrait videosong creator. The user records multiple layers of video+audio; the layers combine into a grid that is simultaneously the visual output (music video) and the multitrack audio mix (song). Spiritual peers: Acapella by Mixcord, 4XCAMERA by Roland, the videosong genre popularised by Pomplamoose / Mike Tompkins.

The existing layout-builder *is* the song. Each cell holds one "voice" — a recorded video+audio take. Splitting/appending the layout adds voices. Playback composites every cell's video into one frame at the cell's rect, and mixes every cell's audio. Export muxes that into an mp4.

## Repo shape

Single Vite app, flat layout. No workspaces, no monorepo.

- `src/` — all application code
- `index.html`, `package.json`, `vite.config.ts`, `tsconfig.json`, `tests/`, `playwright.config.ts` at root
- HEAD reverted past the monorepo refactor to `d68812a`

## Composition model

- Each cell is in exactly one state: `empty` | `recording` | `clip`.
- Existing layout-builder operations — split, append, select, delete-cell — are unchanged.
- **Anchor-take synchronisation.** The first committed recording sets the song's length. Every subsequent recording is clamped to that length.
- The anchor recording is **unbounded** in duration; the user stops it manually. All non-anchor recordings auto-stop at anchor length.
- **Re-record** is implicit: starting a recording on a cell that already has a clip drops the old clip. There is no separate re-record UI.
- **Delete** returns a cell to `empty`. There is no undo.
- If the only remaining clip is deleted, the song length resets — the next recording becomes a new anchor.

## Transport / monitoring

- One shared `AudioContext` is the master clock. All scheduling derives from `audioContext.currentTime`.
- Two transport actions: **Play** and **Stop**. Play auto-loops. There is no pause, no scrub, no seek.
- During recording, every existing voice plays back normally (audio + video). The user is assumed to wear headphones; no echo cancellation or speaker-mute is engineered. If they don't wear headphones, the mic will pick up playback — accepted limitation.

## Tech spine

**Record path**
- `getUserMedia({ video: true, audio: true })` with device defaults. No camera/mic picker.
- `MediaRecorder` writes a Blob.
- On stop: mediabunny demuxes the Blob. Audio chunks are decoded by `AudioDecoder` into a single `AudioBuffer` and held in memory. Video chunks are kept as encoded chunks, fed to the cell's `VideoDecoder` on demand during playback.

**Audio playback**
- One `AudioBufferSourceNode` per voice per playback pass. Scheduled with `start(when)` against `audioContext.currentTime` so all voices are sample-accurate.
- Empty cells contribute no audio.

**Video playback**
- One long-lived `VideoDecoder` per cell, kept alive for the session.
- A render loop ticks each animation frame, reads `audioContext.currentTime`, asks each cell's decoder for "the frame whose presentation timestamp covers this moment", and renders.

**Compositor**
- One WebGL canvas covering the layout, positioned over the layout-builder grid.
- Each cell's current `VideoFrame` is uploaded as a texture and drawn at the cell's rect (computed from the layout tree).
- Empty cells render black.

**Export**
- Off-clock render of the same composite into a `VideoEncoder` + `AudioEncoder`, muxed by mediabunny into an mp4.
- Renders as fast as the encoders accept; not real-time.
- Triggered by an explicit "export" action; produces a downloadable file.

## Persistence

None. All clip state — encoded chunks, decoded audio buffers — lives in memory only. Reloading the page loses the song. (OPFS persistence is a v2 concern; the metadata layer it requires isn't worth it for the MVP.)

## Explicitly out of MVP (v2+)

- Time-as-composition: multiple clips per cell, layout changes over time, automation.
- Trim, nudge, ripple, any non-destructive editing.
- Effects, EQ, per-voice level, pan.
- Tempo, metronome, click-track, bars/beats.
- Camera/mic device picker, multi-camera, screen capture, file import.
- OPFS persistence, atproto, sharing, accounts, social.
- Undo / history.
- Landscape orientation.
- Desktop polish — design target is mobile Chrome only.

## Scaling beyond MVP

Expected simultaneous-voice range is **4–9**. Beyond that, the architecture's escape hatch is the DAW "freeze / bounce" pattern: composite a finished subset of voices into a single video+audio clip and play that one clip back as a single decoder + single audio source, freeing room for new voices on top.

Importantly, **the export pipeline is already a pre-renderer** (composite WebGL → encoders → mux). Bouncing is just export-to-an-in-session-clip rather than export-to-file. The same factoring also unlocks v2 time-as-composition (bounce per layout-state, stitch). The MVP should therefore keep the export pipeline factored as a reusable "composite → encoded clip" routine, even though it's invoked only by the export action in v1.

## Platform assumptions

- Mobile Chrome on Android is the only supported target. WebCodecs (`VideoEncoder`, `VideoDecoder`, `AudioEncoder`, `AudioDecoder`), WebGL, `getUserMedia`, `MediaRecorder` are all available there.
- 4–9 simultaneous voices is the tuned range. Architecture does not preclude more, but performance is not tuned for it.
- Portrait orientation only.

## Stack

- `solid-js` 2.x (already in `package.json`)
- `@solidjs/signals`, `@solidjs/web` 2.x
- `@bigmistqke/view.gl` for WebGL
- `mediabunny` for muxing/demuxing — to be added
- WebCodecs, Web Audio, getUserMedia, MediaRecorder — browser-native
- Vite, TypeScript, Playwright — already present
