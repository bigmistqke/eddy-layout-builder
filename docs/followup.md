# Follow-up items

Things to revisit later. Each entry: date, what, where, why-deferred.

## Pre-existing flake — anchor-take.spec.ts M3

**Surfaced:** 2026-05-18, during mobile CSS pass (Tasks 1 + 2 + 3).
**Where:** `tests/anchor-take.spec.ts:56` — "M3: re-recording the sole clip redefines songLength".
**Symptom:** `waitForFunction` on `__appContext` state times out after the record-stop click. Reproduces on `git stash` of the mobile-CSS pass (verified by the Task 1 implementer); not caused by any of: viewport meta, dvh, safe-area-inset, touch-action, user-select. So it's a pre-existing flake on `main` masked by run-to-run timing variance.
**Why deferred:** Unrelated to the mobile CSS pass. Worth its own investigation — likely a race in the record-stop → setClip → songLength reactivity chain that's been there since the anchor-take feature landed.
**Suggested next step:** Re-run the test in isolation 10× to confirm flake rate; look at recent commits to `src/state/projects.ts`, `src/clips/store.ts`, and `src/hud/main.tsx`'s `onStopRecording` for the racing setter.

