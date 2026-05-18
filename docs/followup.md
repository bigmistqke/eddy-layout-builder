# Follow-up items

Things to revisit later. Each entry: date, what, where, why-deferred.

## Pre-existing flake — anchor-take.spec.ts M3

**Surfaced:** 2026-05-18, during mobile CSS pass (Tasks 1 + 2 + 3).
**Where:** `tests/anchor-take.spec.ts:56` — "M3: re-recording the sole clip redefines songLength".
**Symptom:** `waitForFunction` on `__appContext` state times out after the record-stop click. Reproduces on `git stash` of the mobile-CSS pass (verified by the Task 1 implementer); not caused by any of: viewport meta, dvh, safe-area-inset, touch-action, user-select. So it's a pre-existing flake on `main` masked by run-to-run timing variance.
**Why deferred:** Unrelated to the mobile CSS pass. Worth its own investigation — likely a race in the record-stop → setClip → songLength reactivity chain that's been there since the anchor-take feature landed.
**Suggested next step:** Re-run the test in isolation 10× to confirm flake rate; look at recent commits to `src/state/projects.ts`, `src/clips/store.ts`, and `src/hud/main.tsx`'s `onStopRecording` for the racing setter.

## Run experiment 32 (backdrop-filter cost on A15)

**Surfaced:** 2026-05-18, Task 8 of the mobile CSS pass.
**Where:** `experiments/32_backdrop-filter-cost/` — scaffolded but not run.
**Why deferred:** No adb device connected during the implementation pass.
**Suggested next step:** Plug in the A15, then:
```sh
pnpm dev  # in a separate terminal
TIMEOUT_MS=120000 PORT=5173 experiments/harness/run.sh 32_backdrop-filter-cost
```
Append the findings table (p50/p95/max for baseline + filtered + cost delta) to `experiments/32_backdrop-filter-cost/README.md` per the template at the bottom of that file. Verdict thresholds: ≤2ms cost p95 = ship as-is; 2-5ms = note and move on; >5ms = pursue the spec §6 media-query mitigation as a follow-up.
