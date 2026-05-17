# C2 Prototype — Phase 3 Design

**Date:** 2026-05-18
**Status:** ready for review
**Related:** [phase 2 design](2026-05-18-c2-phase2-design.md), [phase 1 design](2026-05-17-c2-phase1-design.md), [video pipeline experiments review](2026-05-17-video-pipeline-experiments-review.md)

## Scope

Third slice of the C2 architecture port. Replaces WebM clip-blob storage with **AV1 canonical** files (~50 KB per 6 s clip per experiment 27 vs ~2-3 MB for WebM, ~50× smaller persistent footprint), and persists per-clip `clipId`s in the project manifest so the RGBA working cache can **survive across sessions** — skipping the cold-start decode when a clip's cache file is already present.

Phase 3 makes session-reopen near-instant for previously-loaded projects and shrinks persistent storage by ~50×. It does NOT yet change the recording path's capture primitive (MediaRecorder + demux stays; the AV1 encode happens at finalize-time, not capture-time). Phase 4+ may pivot capture to `MediaStreamTrackProcessor` if profiling demands it.

## What stays the same

- `BitmapSource` interface (`latestFrame`, `seek`, `reset`, `close`) — fully transparent
- `BitmapFrame` shape (`bytes`, `width`, `height`)
- `ClipStore`, `Clip` interface (the `clipId` field added in phase 2 stays)
- `Transport`, audio scheduling, loop/volume routing
- `Preview` and live camera adapter (still in-memory)
- Renderer (raw-RGBA-only)
- Per-clip reader worker (`src/media/bitmap-reader-worker.ts` — phase 2)
- `/rgba/<clipId>.bin` working cache layout (phase 2)
- `BitmapSource.close()` async cleanup chain (phase 2)
- All UI components, HUD, layout-builder, state

## What changes

### 1. Canonical storage: WebM → AV1

`src/storage/opfs.ts`: the project's clip blob is now stored as AV1 video in a WebM container (`<cellId>.webm` filename stays for backward compatibility with existing user projects — mediabunny's demuxer routes by codec, not extension). New recordings encode to AV1 at record-stop time; old VP8 WebMs continue to load via the existing demux path (mediabunny is codec-agnostic).

The on-disk path:

```
/projects/<id>/manifest.json
/projects/<id>/clips/<cellId>.webm  (now contains AV1 + Opus instead of VP8 + Opus)
```

No layout change, just codec content change. New cells get AV1; existing cells stay VP8 until re-recorded.

### 2. AV1 encode at record-stop

In `src/hud/main.tsx`'s record-stop handler, before calling `saveClipBlob`, transcode the MediaRecorder VP8 blob to an AV1 WebM blob. The transcode happens in a worker (avoids blocking main-thread playback that may be active).

```ts
// Sketch:
const av1Blob = await transcodeBlobToAv1(vp8Blob)
await context.projects.saveClipBlob(cellId, av1Blob)
```

`transcodeBlobToAv1(vp8Blob)` is a new helper in `src/media/transcode.ts` that:
1. Spawns a worker (`src/media/transcode-worker.ts`)
2. Worker uses mediabunny + WebCodecs `VideoDecoder` (VP8) → `VideoEncoder` (AV1, `av01.0.04M.08`) → mediabunny mux into WebM
3. Posts the result back as a Blob (or transferable ArrayBuffer)

Per experiment 20: AV1 encode at 720p ≈ 32 fps. A 6 s clip = ~6 s of encode time. Per experiment 27: parallel encoders speed up but a single-clip encode is single-stream. Acceptable for record-stop since the user is reviewing the take anyway.

### 3. Manifest persists `clipId`

Bump the manifest's per-cell record from a bare `cellIds: string[]` array to either parallel arrays or a structured form:

```ts
// Option A (parallel arrays — minimal disruption):
interface ProjectManifest {
  // ... existing fields
  cellIds: string[]
  clipIds: Record<string, string>  // cellId → clipId
}

// Option B (structured cells — cleaner):
interface CellRecord {
  cellId: string
  clipId: string
}
interface ProjectManifest {
  // ... existing fields
  cells: CellRecord[]
  // cellIds remains as derived/legacy for migration
}
```

The plan can pick whichever fits the existing manifest shape better. Option A is less invasive (one new field, default-handling for old manifests).

On record-stop, after blob save, update the manifest with the new clipId for that cellId. Existing project save/load paths get this for free if the helpers (`saveClipBlob`, `loadProject`) thread `clipId` through.

### 4. Cross-session RGBA cache reuse on load

Currently (phase 2): on project load, each clip's `blobToClip` reads the WebM blob, decodes to RGBA, writes a fresh `/rgba/<clipId>.bin` file. Cold-start every time.

Phase 3: `blobToClip` checks whether `/rgba/<clipId>.bin` already exists (matching the clipId persisted in the manifest). If yes, skip the decode + write step; just spawn the reader worker directly on the existing file. Massive perf win — opening a 9-cell session can drop from ~5 s to ~50 ms.

If the file is missing (eviction, fresh device, manifest mismatch, etc.), fall through to the existing cold-start path: decode AV1 → write RGBA → spawn worker.

```ts
// In makeBitmapSource:
if (await rgbaCacheExists(clipId)) {
  // Hot path: reuse persistent cache.
  const { width, height, totalFrames } = await readCacheMetadata(clipId)
  return spawnReaderForCache(clipId, width, height, totalFrames)
}
// Cold-start path: decode from canonical, write cache, spawn worker (phase 2 path).
```

The trick: we need `width/height/totalFrames` to set up the reader. Phase 2 derives these from the decode. For the hot path, we need them stored alongside the cache — either in a sidecar metadata file (`<clipId>.meta.json`) or appended as a header. Or carried in the manifest's CellRecord.

Carrying in the manifest is cleanest:

```ts
interface CellRecord {
  cellId: string
  clipId: string
  cacheWidth: number
  cacheHeight: number
  cacheFrames: number
}
```

Manifest writes are already on the save path; one extra small structure per cell.

### 5. Remove startup wipe; replace with manifest-driven cleanup

Phase 2's startup wipe (`wipeRgbaCache` in `src/state/projects.ts`'s `init`) was a heavy hammer because we couldn't trust which rgba files were valid. With clipIds persisted in the manifest, we can compute the "expected" set:

```ts
// At app startup, after loading the projects list:
const expectedClipIds = new Set<string>()
for (const projectId of allProjects) {
  const manifest = await readManifest(projectId)
  for (const cell of manifest.cells) {
    expectedClipIds.add(cell.clipId)
  }
}
await garbageCollectRgbaCache(expectedClipIds)  // delete files not in expected set
```

This preserves the active session's cached files (they're in the expected set), removes truly orphaned files (left over from crashes, deleted projects, etc.).

If `garbageCollectRgbaCache` doesn't exist yet, add it as a new export in `src/storage/rgba-cache.ts`:

```ts
export async function garbageCollectRgbaCache(keep: Set<string>): Promise<void> {
  // ... iterate /rgba/, delete files whose clipId (filename) isn't in `keep`
}
```

### 6. `deleteProject` reads manifest, deletes rgba per cell

With clipIds persisted, the non-active-project-delete case is now trivial:

```ts
async function deleteProject(id: string) {
  const manifest = await readManifest(id)
  if (manifest !== null) {
    for (const cell of manifest.cells) {
      await deleteRgbaCache(cell.clipId)
    }
  }
  await deleteProjectOnDisk(id)
  // ... rest of existing logic
}
```

(Re-introduces what phase 2's Task 4 had, then was removed during the clipId refactor.)

## Out of scope (phase 4+)

- **Capture-time AV1 encode** (replacing MediaRecorder with MediaStreamTrackProcessor + VideoEncoder). Phase 3 keeps the existing capture path; transcodes post-record.
- **Storage-pressure-driven eviction** of RGBA cache. Phase 3's GC is manifest-driven (delete what's not referenced); a true LRU eviction under quota pressure is later.
- **Transport `registerSeek` wiring** to bitmap sources for boundary-driven cursor resets. The API exists from phase 1 but no consumer uses it yet. Phase 4.
- **Worker-side video decode** in the bitmap reader. Currently main-thread; phase 4+ if profiling demands.
- **Shared reader worker pool**. Per-clip workers are correct for current scale.
- **`SharedArrayBuffer`** for zero-overhead frame transfer (needs COOP/COEP headers).
- **Live camera adapter moving to OPFS** — stays in-memory.

## Touch surface

| File | Action |
|---|---|
| `src/media/transcode-worker.ts` | New: worker that takes VP8 WebM blob, transcodes to AV1, returns AV1 WebM blob |
| `src/media/transcode.ts` | New: `transcodeBlobToAv1(blob)` helper that spawns the worker |
| `src/storage/opfs.ts` | `ProjectManifest` gains `cells: CellRecord[]` with `{cellId, clipId, cacheWidth, cacheHeight, cacheFrames}`; legacy `cellIds` kept as derived or migrated |
| `src/storage/rgba-cache.ts` | Add `garbageCollectRgbaCache(keepSet)`; (`writeRgbaCache`, `deleteRgbaCache`, `rgbaCacheExists`, `RGBA_DIR_NAME` unchanged) |
| `src/media/bitmap-source.ts` | `makeBitmapSource` gains hot-path: check `rgbaCacheExists(clipId)` first; if present, skip decode and spawn reader directly with metadata from manifest |
| `src/clips/clip.ts` | `blobToClip(cellId, blob, clipId?, cacheMetadata?)` — accept optional persisted clipId (manifest read) + cache metadata; reuse if present |
| `src/state/projects.ts` | Replace startup `wipeRgbaCache()` with `garbageCollectRgbaCache(expectedSet)`; thread `cells` (with clipIds + cache metadata) through save/load; re-add `deleteRgbaCache` loop in `deleteProject` |
| `src/hud/main.tsx` | Record-stop: `transcodeBlobToAv1` between MediaRecorder stop and `saveClipBlob`; update manifest with new clipId + cache metadata after `setClip` |

Order:
1. AV1 transcode worker + helper (new files, no consumers)
2. Manifest schema bump (default-handling for old manifests)
3. Hot-path cache reuse in `makeBitmapSource`
4. Wire record-stop to transcode + persist
5. Replace startup wipe with manifest-driven GC + restore `deleteProject` rgba cleanup
6. E2E regression + new test for cache-survives-reload

## Success criteria

- All phase 1 + phase 2 E2E tests still pass (~55 tests)
- New test: `tests/c2-cache-survives-reload.spec.ts` — record a clip, reload the page, assert the rgba cache file is reused (verifiable via a timing or trace assertion: cold-start step skipped on second load)
- New test: `tests/c2-av1-canonical.spec.ts` — record a clip, assert the saved blob is AV1 (via mediabunny demux or a magic-number check)
- Session reopen for a 9-cell project drops from phase 2's ~5 s to ~100 ms (informational; verify in dev manually)
- Persistent storage per 9-cell session drops from ~25-50 MB (WebM blobs) to ~0.5-1 MB (AV1 blobs)
- No functional regression: record, play, loop, multi-cell, project save/load/delete all work

## Risks

- **AV1 encode latency at record-stop.** A 6 s clip takes ~6 s to encode on this device per experiment 20. The user is reviewing the take during that time so it's mostly hidden, but for re-record-heavy workflows (where the user records, immediately re-records before reviewing), the encode queue could back up. Mitigation: don't block re-record on encode completion; queue encodes and allow them to complete asynchronously. Manifest update happens when each encode lands.
- **Manifest schema migration.** Existing user projects have manifests with `cellIds: string[]` but no `cells: CellRecord[]`. Need to handle gracefully: if `cells` is missing, derive `cellIds` and generate fresh `clipId`s on first load (no cache reuse for these — old behavior). The migration writes the new schema on next save.
- **Cache metadata staleness.** If `<clipId>.bin` is somehow out of sync with `cacheWidth/Height/Frames` (file truncated, dimensions changed, manual fiddling), the reader will read garbage. Mitigation: include a small magic + version header in the file, validate before spawning the reader; on mismatch, fall through to cold-start.
- **First load of a re-recorded clip in a session.** Re-record allocates a new clipId → no existing cache → cold-start runs. Same UX as phase 2's record-stop. Not a regression.
- **GC race with active workers.** `garbageCollectRgbaCache` runs at startup before any clips load, so no workers hold handles. Safe.
