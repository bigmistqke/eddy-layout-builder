# Experiments — video playback scaling

Throwaway capability spikes, each answering one question about how to scale
video playback to many simultaneous cells on low-end Android (target:
Samsung Galaxy A15 / SM-A155F). Background + the architecture hypotheses
they test: `docs/superpowers/specs/2026-05-14-video-playback-scaling-design.md`.

**These are throwaway.** When an experiment has answered its question,
record the verdict in its `README.md` and delete or absorb the code.

## Layout

Experiment directories are **numbered in investigative order** (`00_`,
`01_`, …) so the train of thought is visible at a glance.

```
experiments/
  index.html          shared shell — loads ?experiment=<NN_name>/index.ts
  harness/
    input.ts          record + demux a fresh clip on the device
    fallback-detect.ts throughput-collapse detector
    report.ts         status() + reportResult() for experiment pages
    run.sh            on-device runner (adb plumbing)
    run-cdp.ts        CDP half — navigates, captures, writes result.json
  NN_<name>/
    README.md         the question, setup, params, verdict, reproduce
    index.ts          the runner (imports the harness)
    measure.ts        (optional) experiment-specific logic
    result.json       latest run — written by run-cdp.ts
```

## How to run

```sh
pnpm dev                                              # serve (note the port)
PORT=<port> experiments/harness/run.sh <NN_name>      # e.g. 01_raw-capability
```

`run.sh` wakes the phone, `adb reverse`s the dev port, grants Chrome's
**OS-level** camera/mic permissions, resolves **Chrome's** DevTools socket
(not Brave's — see below), and forwards it. `run-cdp.ts` then navigates to
`experiments/index.html?experiment=<NN_name>`, streams the device console,
and writes `experiments/<NN_name>/result.json` wrapped with git SHA +
timestamp.

### One-time device setup

- **USB debugging** enabled, USB cable connected, prompt accepted.
- **Per-site camera/mic grant.** No CDP command can grant a site's camera
  on Android Chrome — open the experiment URL once in Chrome on the phone
  and tap **Allow**. It persists per origin (per port). Do not let anything
  call `Browser.resetPermissions` — it wipes this.
- The runner targets **`com.android.chrome`**. Other Chromium browsers
  (Brave especially) also expose a `*_devtools_remote` socket; `run.sh`
  disambiguates by Chrome's PID.

### Reproduce a recorded run

`result.json` records `git.sha` and the exact `params`. To reproduce:
`git checkout <sha>` → `pnpm dev` → `experiments/harness/run.sh <NN_name>`.
To vary an experiment, edit the `params` block in its `index.ts` and commit.

## Index

| # | Experiment | Question | Verdict |
|---|---|---|---|
| 00 | [smoke](00_smoke/README.md) | Will the device hand us a camera stream at all? | harness check, not a finding |
| 01 | [raw-capability](01_raw-capability/README.md) | Raw decode/upload limits? | 2–4 premise falsified, but at 720p one decoder ≈ 3 cells; resolution dominates |
| 02 | [decoder-pools](02_decoder-pools/README.md) | Is the decoder pool actually dead? (sustained concurrent decode) | Not dead, but aggregate 720p decode ≈ ~4–5 streams regardless of decoder count |
| 03 | [grid-streaming](03_grid-streaming/README.md) | Does the real workload (N cells = one viewport) sustain realtime? | Naive attempt — camera clamps resolution; results reproduce but confounded. Only N=4 realtime |
| 04 | [grid-streaming-transcoded](04_grid-streaming-transcoded/README.md) | Same, with correct cell sizes via downscale-transcode | Streaming realtime only at N=4; **re-encoded clips carry a ~1.5–1.7× decode tax** |
| 05 | [compositing-full-video](05_compositing-full-video/README.md) | Does one big atlas decode beat N small streams — *under the same re-encode tax*? | _the head-to-head — built, pending run_ |
| — | windowed-previews | Can per-cell ring buffers give bounded memory at acceptable quality? | _not yet built_ |
