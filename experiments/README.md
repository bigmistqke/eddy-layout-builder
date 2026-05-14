# Experiments — video playback scaling

Throwaway capability spikes, each answering one question about how to scale
video playback to many simultaneous cells on low-end Android (target:
Samsung Galaxy A15 / SM-A155F). Background + the architecture hypotheses
they test: `docs/superpowers/specs/2026-05-14-video-playback-scaling-design.md`.

**These are throwaway.** When an experiment has answered its question,
record the verdict in its `README.md` and delete or absorb the code.

## Layout

```
experiments/
  index.html          shared shell — loads ?experiment=<name>/index.ts
  harness/
    input.ts          record + demux a fresh clip on the device
    fallback-detect.ts throughput-collapse detector
    report.ts         status() + reportResult() for experiment pages
    run.sh            on-device runner (adb plumbing)
    run-cdp.mjs       CDP half — navigates, captures, writes result.json
  <name>/
    README.md         the question, setup, params, verdict, reproduce
    index.ts          the runner (imports the harness)
    measure.ts        (optional) experiment-specific logic
    result.json       latest run — written by run-cdp.mjs
```

## How to run

```sh
pnpm dev                                          # serve (note the port)
PORT=<port> experiments/harness/run.sh <name>     # e.g. raw-capability
```

`run.sh` wakes the phone, `adb reverse`s the dev port, grants Chrome's
**OS-level** camera/mic permissions, resolves **Chrome's** DevTools socket
(not Brave's — see below), and forwards it. `run-cdp.mjs` then navigates to
`experiments/index.html?experiment=<name>`, streams the device console, and
writes `experiments/<name>/result.json` wrapped with git SHA + timestamp.

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
`git checkout <sha>` → `pnpm dev` → `experiments/harness/run.sh <name>`.
To vary an experiment, edit the `params` block in its `index.ts` and commit.

## Index

| Experiment | Question | Verdict |
|---|---|---|
| [smoke](smoke/README.md) | Will the device hand us a camera stream at all? | harness check, not a finding |
| [raw-capability](raw-capability/README.md) | Raw decode/upload limits? | **2–4 decoder premise falsified** — A15 allows ≥32 |
| decoder-pools | Is the decoder pool actually dead? (sustained concurrent decode) | _not yet built_ |
| windowed-previews | Can per-cell ring buffers give bounded memory at acceptable quality? | _not yet built_ |
| compositing-full-video | Does 1-decode-1-upload scale to large N; rebuild cost? | _not yet built — kept as fallback comparison_ |
