# cold-start

**Question:** when the user opens the app and there's a saved project,
how fast can we read the persisted sub-atlases from OPFS, decode them,
and have the first frame ready? Target: ~1 second.

## Why

The flow design (this conversation, not yet written up) decided that
sub-atlases are persisted to OPFS so cold-start opens directly into
`playing-atlas` instead of paying the ~30-60s rebuild cost. We need to
confirm "directly" is actually ~1s and not 10s.

There are two scales:
- **One atlas** — single sub-atlas read + decode. The base unit.
- **K sub-atlases in parallel** — the production case (K=4 leaf
  containers means 4 atlases to bring online before the first frame
  can be drawn).

## Setup

For each pass:

1. **Bake.** Record a source clip and build an atlas with
   `harness/composite.ts`.
2. **Persist.** Serialize the atlas (decoder config + encoded chunks)
   to a binary blob; write to OPFS. Report file size.
3. **Cool down.** Drop all in-memory references to the atlas (forcing
   any subsequent decode to come from disk).
4. **Cold-start measurement:**
   - `t0` = start
   - `t1` = OPFS file opened
   - `t2` = read complete (blob → ArrayBuffer → deserialized chunks)
   - `t3` = `VideoDecoder.configure` resolved
   - `t4` = first frame output by the decoder

Two passes:
- **Single-atlas pass** — one atlas, sequential.
- **K=4 parallel pass** — four atlases read + decoded concurrently;
  report max `t4 - t0` across the four (= time until *all* atlases
  have first frames).

## What to look for

- `t4 - t0` ≤ 1000ms for single-atlas → target met for the simple
  case.
- `max(t4 - t0)` ≤ ~1500ms for K=4 parallel → target met for the
  production case (slight overhead from concurrent decoder init is
  acceptable).
- File size in OPFS is sensible (~hundreds of KB to a few MB per
  sub-atlas) so storing K of them isn't a problem.

If `t1`/`t2` dominate, OPFS read is the bottleneck. If `t3`/`t4`
dominate, decoder init is. Each suggests a different optimization.

## Caveats

- Atlas serialization uses a custom binary format (length-prefixed
  chunks + JSON config header). A production version would use a real
  WebM container (mediabunny mux); the timing would differ slightly
  but the disk-read + decode-init costs should dominate either way.
- Source clip is 4s at the harness default. Real song-length atlases
  (30s+) are bigger on disk but decode-init is proportional to first
  GOP only, so `t3`/`t4` shouldn't grow with clip length.

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
PORT=<port> experiments/harness/run.sh 13_cold-start
```
