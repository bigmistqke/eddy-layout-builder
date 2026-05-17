# C2 Prototype — Phase 2 Design

**Date:** 2026-05-18
**Status:** phase 2 complete
**Related:** [phase 1 design](2026-05-17-c2-phase1-design.md), [video pipeline experiments review](2026-05-17-video-pipeline-experiments-review.md)

## Scope

Second slice of the C2 architecture port. Moves the RGBA frame cache that `makeBitmapSource` currently holds in memory into **OPFS**, with a per-clip reader worker streaming bytes back to main thread per the [24g pattern](../../../experiments/24g_opfs-bitmap-render/README.md).

Phase 2 makes memory bounded regardless of clip length / cell count, which is what 18b's OOM finding and 24g's storage validation called for. The BitmapSource interface and all consumers stay identical — only the backing storage changes.

Phase 2 does NOT yet add:
- AV1 canonical encode/decode (phase 3)
- Cold-start path from saved AV1 (phase 3)
- Transport/seek wiring (phase 4)

After phase 2, the app should still record, play, loop, and persist projects identically — but with constant memory in number of cells and seconds of clip content.

## What stays the same

- `BitmapSource` interface (`latestFrame`, `seek`, `reset`, `close`)
- `BitmapFrame` shape (`bytes`, `width`, `height`)
- `Clip` interface, `ClipStore`
- `Transport`, audio scheduling, loop/volume routing
- `Preview` and live camera adapter (still in-memory; transient)
- Renderer (raw-RGBA-only, unchanged from phase 1)
- All UI components, HUD, layout-builder, state
- Existing WebM blob storage for clips (phase 3 replaces this)

## What changes

### 1. `makeBitmapSource(track)` — OPFS-backed

`src/media/bitmap-source.ts`: replace the in-memory `CachedRgbaFrame[]` array with an OPFS file per clip. The body still iterates `VideoSampleSink`, decodes each `VideoFrame` via `copyTo({format:'RGBA'})`, but writes each frame's bytes to an OPFS file instead of pushing into an array. Returns a `BitmapSource` whose `latestFrame()` reads from a per-clip reader worker.

```ts
export async function makeBitmapSource(
  track: InputVideoTrack,
  cellId: string,
): Promise<BitmapSource>
```

New `cellId` parameter — used to derive the OPFS file path so the worker knows what to read. Caller (in `blobToClip`) already has the cellId; one extra arg passed.

The decode + write to OPFS happens synchronously inside `makeBitmapSource` (one-shot at clip creation). Reader worker spawns at the end and starts streaming. Returns when the worker reports "ready" with the first frame available.

### 2. Per-clip OPFS layout

New directory in the existing OPFS hierarchy:

```
/projects/<projectId>/rgba/<cellId>.bin
```

File format: raw RGBA bytes, frames concatenated, no header. Each frame is `width × height × 4` bytes (constant per file since we don't change resolution mid-clip).

The reader worker needs to know `width`, `height`, and `totalFrames` to address frames — these are stored in the OPFS file's parent directory's manifest or carried via the worker init message. Since the manifest already exists for the project, easiest is to put the dimensions in the init message (the decode just produced them).

### 3. Reader worker per clip

`src/media/bitmap-reader-worker.ts`: a per-clip worker, mirrors the experiment's [`24g_opfs-bitmap-render/bitmap-reader-worker.ts`](../../../experiments/24g_opfs-bitmap-render/bitmap-reader-worker.ts) pattern.

Init message:
```ts
{
  type: 'init',
  dirName: string,         // e.g. 'projects/<id>/rgba'
  fileName: string,        // e.g. '<cellId>.bin'
  frameSize: number,       // width × height × 4
  totalFrames: number,
  sourceFps: number,       // 30
}
```

Worker opens `FileSystemSyncAccessHandle`, maintains a cursor (advanced at source-fps), reads the current frame, posts `{type:'frames', frames: [{cellId, bytes}]}` to main using transferable ArrayBuffer. On `{type:'seek', tSeconds}`, sets the cursor to the nearest frame. On `{type:'stop'}`, closes the handle and exits.

Per-clip worker is the simplest model — keeps isolation and matches the BitmapSource per-clip lifecycle. Phase 4+ might consolidate to a shared worker once the read/IPC patterns are well-understood, but YAGNI here.

### 4. `BitmapSource` implementation

The returned object exposes the same contract but is backed by the worker:

```ts
return {
  latestFrame(): BitmapFrame | null {
    return latest // most recent bytes from the worker, or null
  },
  seek(tSeconds): void {
    worker.postMessage({ type: 'seek', tSeconds })
  },
  reset(): void {
    worker.postMessage({ type: 'seek', tSeconds: 0 })
  },
  close(): void {
    worker.postMessage({ type: 'stop' })
    worker.terminate()
    // Optionally delete the OPFS file. Phase 2: leave it (no eviction
    // strategy yet); phase 3+ may garbage-collect.
  },
}
```

The `latest` reference is owned by the BitmapSource closure; the worker posts new ArrayBuffers (transferable), and the BitmapSource updates `latest`. Borrowed-buffer contract from phase 1 still holds — callers consume within the tick.

### 5. Project deletion / cleanup

When a clip is removed (`ClipStore.clearClip(cellId)` → `disposeClip(clip)` → `clip.video.close()`), the worker tears down. The OPFS file is left behind for now (phase 3 adds proper lifecycle management aligned with AV1 storage).

When a project is deleted from OPFS, the existing project-removal path needs to also remove the `rgba/` subdirectory. Small change in `src/storage/opfs.ts`.

## Out of scope (phase 3+)

- AV1 canonical encode (phase 3)
- AV1 → RGBA cold-start on session load (phase 3)
- RGBA cache eviction / GC (phase 3, tied to AV1 lifecycle)
- Shared reader worker pool (phase 4+ optimisation)
- SharedArrayBuffer for zero-overhead frame transfer (per [24g's follow-up note](../../../experiments/24g_opfs-bitmap-render/README.md); needs COOP/COEP headers)
- Worker-side decoding of the source WebM (currently main-thread per phase 1)
- Live camera adapter moving to OPFS (stays in-memory; transient)

## Touch surface

| File | Action |
|---|---|
| `src/media/bitmap-source.ts` | Rewrite `makeBitmapSource`: per-frame write to OPFS during decode; spawn reader worker; return OPFS-backed BitmapSource |
| `src/media/bitmap-reader-worker.ts` | New: per-clip reader worker (port of 24g) |
| `src/clips/clip.ts` | Pass `cellId` to `makeBitmapSource` |
| `src/storage/opfs.ts` | Helper to derive the per-project rgba dir path; remove `rgba/` on project deletion |

Order:
1. Reader worker (new file, no consumers yet)
2. Rewrite `makeBitmapSource` to use it
3. Wire `cellId` through `blobToClip` → `makeBitmapSource`
4. OPFS cleanup path in `storage/opfs.ts`
5. E2E regression

## Success criteria

- All phase 1 E2E tests still pass (54 tests)
- New test: `tests/bitmap-source-opfs.spec.ts` — verifies the file is created in OPFS after clip load, removed after `clip.close()` (or at least: the reader worker stops), and that `latestFrame()` returns frames during playback
- Memory peak during a 9-cell session is significantly lower than phase 1's pre-decoded in-memory equivalent (informational — not enforced by test, but worth eyeballing in dev)
- No functional regression: record, play, loop, multi-cell, project save/load all work identically

## Risks

- **Reader worker startup latency.** Each clip creates a worker. K=9 clips = 9 workers spawning at session load. 24g measured this was viable but the spawn time wasn't a single value; needs verification in production app context (more JS bundle loading happening concurrently).
- **OPFS read sustained throughput at K=9.** 24g validated this at K=9 / K=25 with zero empty-cell ticks. Should hold; flag if 18c-era jank reappears.
- **Cleanup races.** If a user removes a cell mid-playback, the BitmapSource's close races with the worker's in-flight read. Worker should handle "file removed" gracefully (current reader logic returns `done` from the reader; verify with the project-deletion path).
- **First-frame availability after close+create.** If the worker takes a few ms after init to deliver the first frame, the render loop may briefly show no frame for that cell. Phase 1's snap-to-first-frame fallback was synchronous; phase 2's is async-via-worker. Smoke test should confirm the visual transition is acceptable.
- **Per-cell file sizes.** A 6 s × 270p clip is ~30 MB on disk. K=16 session = ~480 MB. Within typical OPFS quotas (per the [storage discussion](2026-05-17-video-pipeline-experiments-review.md)), but worth keeping in mind for long sessions. Phase 3's AV1 storage replaces this.
