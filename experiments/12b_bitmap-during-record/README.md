# bitmap-during-record

**Question:** can we generate the bitmap series *during* the recording
itself — so it's ready the moment the user stops — without contending
with capture?

## Why

[12](../12_bitmap-series/README.md) found bitmap build is 0.34×
realtime (~10s for a 30s clip). That gap between "stop record" and
"playing-bitmaps" is annoying — the cell shows a static last-recorded
frame for ~10s before the series streams in.

If we tap the camera's raw frame stream during the recording and emit
bitmaps in parallel with `MediaRecorder`'s encode path, the bitmap
series is **complete the moment recording stops**. The
`pending-bitmaps` state collapses to zero duration.

## Setup

For one pass:

1. `getUserMedia` for camera + mic.
2. Clone the video track twice — one feeds `MediaRecorder`, the other
   feeds `MediaStreamTrackProcessor` (whose `readable` is transferred
   to a Worker).
3. Worker reads `VideoFrame`s, downscales to bitmap canvas, emits
   `ImageBitmap` per frame, posts each back to main thread.
4. Run for `recordSeconds`, then stop.

Reports:
- `recordedFrames` (post-demux of the MediaRecorder blob — the encode
  path's frame count)
- `bitmapsEmitted` (from the worker)
- `bitmapBacklog` if any (frames the worker received but hadn't
  bitmap'd yet at stop)
- Per-bitmap latency (rough — wall-clock between worker receiving the
  VideoFrame and posting the bitmap)
- `captureFps` derived

## What to look for

- **`bitmapsEmitted` ≈ `recordedFrames`** → the bitmap pipeline keeps
  up with capture. Series is complete at stop.
- **`bitmapsEmitted` << `recordedFrames`** → the bitmap path lags;
  series is sparse or incomplete. May still be acceptable for preview
  (~half-rate is fine), but worth knowing.
- **`recordedFrames`** unaffected vs. a no-bitmap baseline → bitmap
  generation isn't starving the encoder.

If all three hold, `pending-bitmaps` goes away and the design's gap
disappears.

## Note for eddy implementation

- **This is THE recording path.** Use `MediaStreamTrackProcessor` +
  Worker for bitmap generation alongside `MediaRecorder`. Do NOT
  defer bitmap building to a post-stop step — 12 measured that at
  0.34× realtime, so a 30s clip → 10s gap before `playing-bitmaps`
  starts. Generating during-record is essentially free (3.6ms mean
  latency, 100% keep-up) and collapses that gap to zero.
- **Clone the track** so MediaRecorder gets the original and the
  bitmap worker gets a copy. Both consume from the same camera
  source independently; neither blocks the other.
- **Compatibility fallback:** if `MediaStreamTrackProcessor` is ever
  unavailable on a target browser, fall back to `requestVideoFrame-
  Callback` on the existing preview `<video>` element. That path
  stays on the main thread (+30ms/s overhead) but still meets the
  contract — bitmaps ready at stop.

## Caveats

- `MediaStreamTrackProcessor` is Chrome-only and behind no flag on
  recent Android Chrome (148 here). If unavailable, this experiment
  errors out and we fall back to `requestVideoFrameCallback` on a
  `<video>` element (main-thread path, +30ms/s overhead).
- Single resolution measured (96×174, matching 12). Higher bitmap
  resolutions cost more per frame and might lag.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
PORT=<port> experiments/harness/run.sh 12b_bitmap-during-record
```
