# Video playback scaling — prototypes

Throwaway capability spikes, each answering one question about how to scale
video playback to many simultaneous cells on low-end Android (target:
Samsung Galaxy A15 / SM-A155F). Background + the architecture hypotheses
they test: `docs/superpowers/specs/2026-05-14-video-playback-scaling-design.md`.

**These are throwaway.** When a prototype has answered its question, record
the verdict here and delete or absorb the code.

## How to run

```sh
pnpm dev                                  # serve (note the port)
PORT=<port> scripts/prototypes/run.sh <prototype-name>
```

`run.sh` handles the phone: wake, `adb reverse`, grant Chrome's OS
camera/mic permissions, forward the DevTools socket, then `run-cdp.mjs`
grants the site permission, navigates to the prototype page, and prints its
`[prototype-result]` JSON.

Shared harness in `harness/`: `input.ts` (record + demux a fresh clip on
device), `fallback-detect.ts` (throughput-collapse detector).

## Prototypes

### raw-capability — _question:_ what are the device's raw decode/upload limits?

Measures M1 concurrent `VideoDecoder` ceiling, M2 reset/reconfigure cost,
M3 single-decoder throughput, M4 `texImage2D` upload cost.

**Verdict:** _pending first device run._

### decoder-pools — _question:_ is the decoder pool actually dead?

_Not yet built._ K decoders round-robin GOP-decode-ahead across N>K cells.

**Verdict:** _pending._

### windowed-previews — _question:_ can per-cell ring buffers give bounded memory at acceptable quality?

_Not yet built._

**Verdict:** _pending._

### compositing-full-video — _question:_ does 1-decode-1-upload scale to large N, and what's the rebuild cost?

_Not yet built._

**Verdict:** _pending._
