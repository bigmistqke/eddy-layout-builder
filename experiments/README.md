# Experiments — video playback scaling

Throwaway capability spikes, each answering one question about how to scale
video playback to many simultaneous cells on low-end Android (target:
Samsung Galaxy A15 / SM-A155F). Background + the architecture hypotheses
they test: `docs/superpowers/specs/2026-05-14-video-playback-scaling-design.md`.

**These are throwaway.** When an experiment has answered its question,
record the verdict in its `README.md` and delete or absorb the code.

**README sections.** Each experiment's `README.md` should carry:

- **Question** — the single thing the experiment answers
- **Setup / Why** — the shape of the test and the prior unknown it
  closes
- **Verdict** (post-run) — the numbers and the call they support
- **Note for eddy implementation** — any production-relevant
  technique or gotcha that surfaced during the run (e.g. "pre-warm
  the decoder 1 frame ahead of the boundary"). These are how
  experiment learnings flow into the eventual `src/` work without
  being lost in commit messages. Add them when you spot one, even if
  it's small.
- **Caveats** — what wasn't tested or remains uncertain
- **Reproduce** — the command + git SHA

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
| 05 | [compositing-full-video](05_compositing-full-video/README.md) | Does one big atlas decode beat N small streams — *under the same re-encode tax*? | **Yes, decisively** — O(1) in N, 78–110 fps at any N vs streaming's cliff (caveat: identical-tile content) |
| 06 | [grid-streaming-workers](06_grid-streaming-workers/README.md) | Is streaming's poor scaling partly main-thread contention? (decoders in Web Workers) | **No** — workers ≈ main thread; it's hardware-decode-bound |
| 07 | [compositing-workers](07_compositing-workers/README.md) | Can the composite build + decode run off the main thread? | **Yes** — worker-safe; build can be backgrounded |
| 08 | [build-cost](08_build-cost/README.md) | How does atlas build time scale with clip length? | **~1.2× realtime, linear** (not ~2×); but 16s single-pass OOM-crashed → chunking mandatory |
| 09 | [concurrent-build](09_concurrent-build/README.md) | Can the atlas build run during recording without degrading capture or playback? | **No** — build slips 1.2× → 2.4–2.6× realtime under contention; capture drops 26–54% |
| 10 | [sub-atlas-rebuild](10_sub-atlas-rebuild/README.md) | Does splitting into K sub-atlases make rebuild-during-recording fit (1/K build cost, K decoders)? | **Yes** at K=4 CSS-pixel res — build 1.18× contended, capture −16%, playback realtime |
| 11 | [container-aligned-atlases](11_container-aligned-atlases/README.md) | Does K=4 hold at K=6/8 with heterogeneous sub-atlas sizes (one per leaf container)? | **Yes** — holds to K=8, gets *better* with K (build 1.13-1.16×, min fps rises) |
| 12 | [bitmap-series](12_bitmap-series/README.md) | Does the gap-filler bitmap-series approach hold end-to-end (build, paint, contend)? | **Yes** at K≤4 — build 0.34× realtime, paint K-indep, atlas holds at K=4 |
| 12b | [bitmap-during-record](12b_bitmap-during-record/README.md) | Can bitmaps be generated DURING recording (via MediaStreamTrackProcessor), so the series is ready at stop? | **Yes** — 100% keep-up, mean latency 3.6ms — `pending-bitmaps` state goes to zero |
| 13 | [cold-start](13_cold-start/README.md) | How fast can persisted sub-atlases be read from OPFS, decoded, and ready (target ~1s)? | **Yes** — single 219ms, K=4 parallel 561ms |
| 14 | [atlas-swap](14_atlas-swap/README.md) | How big is the handoff gap when an atlas decoder is swapped at a loop boundary? Can pre-warming make it frame-accurate? | **Yes** — cold 270ms, hot (pre-warmed + held VideoFrame) 0ms |
| 15 | [distinct-content](15_distinct-content/README.md) | Does the K=4 sub-atlas verdict hold when each cell holds DIFFERENT content (real-session entropy)? | **Yes** — +4% bytes, −5% fps (noise); cross-cell entropy not load-bearing |
| 16 | [swap-with-bitmap-hold](16_swap-with-bitmap-hold/README.md) | Can the atlas-swap pattern use ImageBitmap-hold (durable) instead of VideoFrame-hold (opaque GC), surviving 5s / 30s? | **Yes** — bitmap & decoder state both survive 30s; post-idle delta decode 12-34ms |
| 17 | [render-loop](17_render-loop/README.md) | What fps does the full rAF-driven render pipeline (N cells + K atlas decoders + capture + rebuild) actually deliver? | **20fps ❌** — render work fits 60fps but flat-out decoders starve rAF; production must pace decoders to playhead |
| 17b | [render-loop-paced](17b_render-loop-paced/README.md) | Same as 17 but with decoders paced via rAF tick. Does pacing recover the fps? | **Steady-state 60fps ✓✓; contended 22fps** — pacing barely moved contended (browser rate-limits rAF under load); steady-state is the real headline |
| 18 | [progressive-record](18_progressive-record/README.md) | Does the full pipeline compose end-to-end? 9 progressive recordings, splitting viewport each time. | **Yes** — runs clean, ~60fps record, 50fps rebuild; NEW: rebuild cost is linear in cells-per-atlas (mono-atlas walls past ~5-6 cells) |
| 18b | [progressive-overlap](18b_progressive-overlap/README.md) | What's the real between-takes gap (production overlap shape)? What jank hides in 18's averaged fps? Were all camera frames actually captured? | **OOM partway** — overlap shape works (gap ~0ms) but in-memory bitmaps OOM the tab; stage 2 surfaced p95 100ms / max 550ms jank |
| 18c | [opfs-bitmaps](18c_opfs-bitmaps/README.md) | Does OPFS-backed bitmap storage (raw RGBA per-cell file + pre-fetch worker) fix the memory ceiling without tanking fps? | **Yes** — 10 MB peak, gap ~0 ms, gl.clear required for paint; jank during recording is rebuild contention (17b), not OPFS |
| 18d | [progressive-streams](18d_progressive-streams/README.md) | Does pure streaming (K=1…9 decoders, no atlas, no bitmaps, no worker rebuild) hold realtime through the 9-stage progressive recording? | **K≤3 smooth, K=4 hitches, K≥5 janky.** Pure streaming is the right path for K≤4; beyond that needs atlas grouping. `framesOver33ms` is the honest smoothness metric, not mean fps. |
| 18e | [yielding-build](18e_idle-build/README.md) | Does building the atlas in temporal chunks (with yields between) reduce the rebuild-during-record contention? | **Yes, completely** — chunked = baseline jank (score 0.0), mono = score 162; chunked also ~25% faster total |
| 18f | [progressive-chunked](18f_progressive-chunked/README.md) | 18 redone with chunked builds (per 18e). Does the chunked pattern hold up through the 9-stage progressive flow as the atlas grows? | **Yes** — render stays 58-60fps through all 9 stages; chunked beats mono's buildFps at every stage (e.g. stage 9: 60.1 vs 50.0) |
| 18g | [progressive-overlap-chunked](18g_progressive-overlap-chunked/README.md) | Full hot-path: capture + OPFS-bitmap render of previous cells + chunked atlas build in background, all concurrent. | **Yes** with cached chunk-worker — recording smooth (57-60fps) at K=1..9, 10 MB peak heap. First attempt with per-stage workers OOMed/janked from re-decoding all sources every build; long-lived cached worker fixed it |
| 19 | [decoder-pool-time-slice](19_decoder-pool-time-slice/README.md) | Can one VideoDecoder serve K cells via batched switches + per-cell ring buffers, extending decoder budget past the K=4 streaming wall? | **Partially** — pureSwitchMs ~77ms confirms 01; 1 decoder serves ~1.4-2.5 cells; for K>3 need multi-decoder pool |
| 19b | [decoder-pool-multi](19b_decoder-pool-multi/README.md) | Multi-decoder pool: N decoders × cells_per_decoder cells. Validates K=4/K=8/K=12 with N=2 and N=4. | Decoder count hits aggregate wall ~165 fps regardless of N; per-cell fps falls as K grows, so atlas still required past K≈4 |
| 19c | [software-decoder](19c_software-decoder/README.md) | Does `hardwareAcceleration: 'prefer-software'` sidestep the GPU decode-bandwidth ceiling? Compares HW vs SW at N=1, 4, 8. | **Surprising**: SW solo 151 fps vs HW solo 91 fps; SW switch cost 13 ms vs HW 261 ms; both saturate at ~165 fps aggregate |
| 19d | [combo-hw-sw](19d_combo-hw-sw/README.md) | Are HW and SW decoder pools independent? Combo HW+SW concurrent vs each alone. | **Yes, fully additive** — combo-4+4 = 318 fps (HW 162 + SW 156), matches hw-alone + sw-alone within noise. K=10 streaming becomes realtime on VP8 |
| 20 | [codec-survey](20_codec-survey/README.md) | Encode + decode throughput across VP8 / VP9 / H.264 / AV1 (HW + SW). Is the bandwidth wall VP8-specific or fundamental? | **Largely VP8-specific.** VP9-SW 263 fps, AV1-SW **376 fps**; H.264 encoder unavailable on Chrome 148 Android. AV1 also 2.3× smaller. K=4 wall dissolves for VP9/AV1 |
| 20b | [codec-combo-contention](20b_codec-combo-contention/README.md) | Does VP9/AV1 solo decode (20) survive 4HW+4SW contention, or collapse like a shared bottleneck? | **AV1 SW pool wins**: VP8 combo 362, VP9 combo 287 (SW collapses 263→93), AV1 SW-4 alone **551 fps** = K=18 |
| 20c | [cross-codec-dual-pool](20c_cross-codec-dual-pool/README.md) | Does 19d's HW+SW additivity hold with different codecs per pool? (VP9-HW + AV1-SW). | **Mostly no** — predicted 632, actual 459 (both pools −25-30% under cross load). +1 cell over single pool, doesn't justify 2× storage |
| 20d | [resolution-codec-pool](20d_resolution-codec-pool/README.md) | Does 20c's cross-codec non-additivity shrink at lower res (memory bandwidth hypothesis)? Sweep {720p,540p,360p} × {vp9-hw, av1-sw, cross}. | **AV1-SW at lower res is staggering** (540p=821fps=K27, 360p=1690fps=K56); cross-codec gets *worse* at lower res (additivity 77→70→65%). Falsifies memory-bandwidth hypothesis; points to main-thread callback saturation |
| 21 | [device-profile](21_device-profile/README.md) | Minimal first-launch probe → portable JSON profile (capture/storage/cache codec + estimated max cells). | **Works** — ~30s probe on A15, picks capture=vp9 storage=vp9 cache=av1 maxCells≈20; numbers cross-validate with 20/20b within ~10% |
| 23 | [sw-workers](23_sw-workers/README.md) | Does putting AV1 SW decoders into Web Workers help (06 said no for HW; SW is different)? Does workerised SW + main-thread HW recover 20c's lost cross-codec additivity? | **No, at 720p** — SW main 448 vs workers 443 (identical); cross-4+4 main 469 vs sw-workers 472 (identical). Bottleneck likely Chrome GPU service IPC, not main thread. Low-res case untested |
| 24 | [render-loop-av1-multires](24_render-loop-av1-multires/README.md) | End-to-end: K cells × per-K mip × AV1-SW decoders × rAF + texImage2D. Does 20d's single-pool multi-res architecture survive paint? | **K≤9 yes** (53-60fps, ~0-12% over 33ms); **K≥16 no** (34fps, 73% over 33ms). Decode keeps up — texImage2D+draw per cell is the new ceiling. Atlas is back for K≥12 |
| 24a | [render-loop-av1-atlas](24a_render-loop-av1-atlas/README.md) | Does atlas grouping (M sub-atlases × C cells) recover smoothness at K=16/25 where 24's per-cell architecture saturated rAF? | _not yet run_ |
| — | windowed-previews | Can per-cell ring buffers give bounded memory at acceptable quality? | _likely obsolete — memory was never the wall_ |
