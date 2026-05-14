# compositing-full-video

**Question:** does decoding **one atlas frame** (all N cells packed into
one viewport-sized image, one re-encoded stream) beat N independent
streams? — the head-to-head against [04](../04_grid-streaming-transcoded/README.md).

## Why

03 and 04 found streaming N decoders sustains realtime only at N≈4 —
per-decode/per-stream overhead is the wall. The composite's whole pitch
is to pay that overhead **once**: pack all N cells into a single frame,
decode that one stream, sample sub-rects at draw time.

But 04 also found a **re-encode decode tax** (~1.5–1.7× per pixel) on
anything that goes through WebCodecs `VideoEncoder` rather than the
camera's hardware encoder. The atlas is `VideoEncoder` output too — so
this experiment must measure it under that same tax. That's the fair
fight: `harness/composite.ts` builds the atlas the same way
`transcode.ts` builds a cell, so both sides pay the tax.

## Setup

Records once at `captureResolution`. For each N in `gridSizes`
(4, 9, 16, 25 — matches 04), `harness/composite.ts` tiles the source
into a √N×√N grid filling `atlasResolution` (~1080×1965, the A15
viewport, snapped to 16-px macroblock alignment) and re-encodes it as
one stream. Then one decoder loops that atlas for `runSeconds`.

**Read it as:** the atlas's fps *is* the fps for all N cells at once.
Compare directly to 04's per-decoder `minFps` at the same N:

- If atlas fps stays ≥ ~30 as N grows while 04 fell off → **composite
  wins**, and it's O(1) in N as advertised.
- If atlas fps also sags (big viewport-res decode + the re-encode tax)
  → the composite is not the easy win, and the design space reopens.

## Verdict

_Pending first device run._

## Reproduce

```sh
git checkout <result.json git.sha>
pnpm dev
PORT=<port> experiments/harness/run.sh 05_compositing-full-video
```
