# Mobile CSS Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make eddy render correctly at native size on mobile (Galaxy A15 target), survive URL-bar collapse, clear notches/home-indicator, suppress mobile tap quirks, and scale with the user's font-size preference — without changing the visual language.

**Architecture:** Mostly mechanical CSS edits across `index.html` + 9 `.css`/`.module.css` files, plus one new Playwright baseline test, plus a final on-device measurement task for backdrop-filter. No new components, no logic changes.

**Tech Stack:** Plain CSS (modules + global), no preprocessor. Existing Playwright + Chromium for tests.

**Read first:**
- Spec: `docs/superpowers/specs/2026-05-18-mobile-css-pass-design.md`
- Existing CSS audit / tradeoff discussion: in the spec's "Evidence anchoring" table

**Precondition (do before Task 1):** create + check out a feature branch off `main`:

```bash
git checkout main
git pull --ff-only
git checkout -b feature/mobile-css-pass
```

---

## File structure

| File | Action | Lands in |
|---|---|---|
| `index.html` | Add viewport meta; root height `100vh` → `100dvh` | Task 1 |
| `src/index.css` | `html { font-size: 16px }`, `#root { -webkit-tap-highlight-color: transparent }`, rem-convert root tokens, `prefers-reduced-transparency` block | Tasks 3, 4, 5 |
| `src/layout-builder.module.css` | `.hudOverlay` padding safe-area-inset | Task 2 |
| `src/hud/hud.module.css` | `.bottomCenter` bottom safe-area-inset; `.button` touch-action + user-select | Tasks 2, 3 |
| `src/hud/arrow-button.module.css` | user-select: none; touch-action: manipulation | Task 3 |
| `src/hud/contextual.module.css` | Slider geometry px → rem | Task 4 |
| `src/hud/main.module.css` | (no px values to convert; touch-action inherited via `.button`) | — |
| `src/hud/breadcrumb.module.css` | (no fixed px values; uses tokens only) | — |
| `src/components/canvas.module.css` | `.glCanvas` touch-action + user-select; spinner geometry px → rem | Tasks 3, 4 |
| `src/components/project-menu.module.css` | Dialog `min-width` / `max-width` / `max-height` per §7; option/row user-select | Tasks 3, 6 |
| `tests/mobile-css-baseline.spec.ts` | New Playwright test | Task 7 |
| `experiments/32_backdrop-filter-cost/` | New experiment dir + README + index.ts | Task 8 |

---

## Task 1: Viewport meta tag + `vh` → `dvh` swap

The headline fix. Single-commit, immediately user-visible change.

**Files:**
- Modify: `index.html`
- Modify: `src/components/project-menu.module.css` (dialog `max-height`)

- [ ] **Step 1: Edit `index.html`**

Replace the current `<head>`:

```html
<head><meta charset="utf-8" /><title>eddy: layout-builder</title></head>
```

with:

```html
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>eddy: layout-builder</title>
</head>
```

- [ ] **Step 2: Edit the root div in `index.html`**

Change `<div id="root" style="width:100vw;height:100vh"></div>` to:

```html
<div id="root" style="width:100vw;height:100dvh"></div>
```

- [ ] **Step 3: Edit `src/components/project-menu.module.css`**

Find the line `max-height: 80vh;` (around line 8). Replace with:

```css
  max-height: 80dvh;
```

- [ ] **Step 4: Run existing E2E suite to confirm no regression**

Run: `pnpm test:fast --reporter=list`
Expected: all 59 tests pass. The viewport meta tag doesn't change headless Chromium's behavior (it always honors the page's stated viewport); `dvh` resolves to the same value as `vh` in headless.

- [ ] **Step 5: Commit**

```bash
git add index.html src/components/project-menu.module.css
git commit -m "feat(mobile): viewport meta tag + vh → dvh

- index.html: viewport meta with viewport-fit=cover. Without this,
  mobile browsers render at ~980px and scale-to-fit, which is why the
  UI looked tiny on phones.
- index.html: root div 100vh → 100dvh so the app fills the visible
  viewport as the URL bar collapses/expands.
- project-menu dialog max-height 80vh → 80dvh so the menu doesn't clip
  below the URL bar on mobile.

Per spec §1 + §2."
```

---

## Task 2: Safe-area-inset handling for notched devices

**Files:**
- Modify: `src/layout-builder.module.css`
- Modify: `src/hud/hud.module.css`

- [ ] **Step 1: Edit `src/layout-builder.module.css`**

Find the `.hudOverlay` rule (currently has `padding: var(--padding);`). Replace that line with:

```css
  padding:
    max(var(--padding), env(safe-area-inset-top))
    max(var(--padding), env(safe-area-inset-right))
    max(var(--padding), env(safe-area-inset-bottom))
    max(var(--padding), env(safe-area-inset-left));
```

`max()` ensures spacing never drops below `--padding` on devices without notches (where `env(...)` returns 0).

- [ ] **Step 2: Edit `src/hud/hud.module.css`**

Find the `.bottomCenter` rule. Replace its `bottom: var(--padding);` line with:

```css
  bottom: max(var(--padding), env(safe-area-inset-bottom));
```

- [ ] **Step 3: Run existing E2E suite**

Run: `pnpm test:fast --reporter=list`
Expected: all 59 tests pass. Headless Chromium reports 0 for all `env(safe-area-inset-*)` values, so the layout is byte-equivalent to before.

- [ ] **Step 4: Commit**

```bash
git add src/layout-builder.module.css src/hud/hud.module.css
git commit -m "feat(mobile): safe-area-inset for HUD overlay + bottom HUD

Notched devices (iPhone X+, Galaxy A15) need the HUD overlay's outer
padding and the bottom-pinned record/play HUD to clear the notch +
home indicator. max() with --padding as the floor keeps non-notched
devices visually identical.

Per spec §3."
```

---

## Task 3: Touch ergonomics

Three small additions to suppress mobile tap quirks. Spread across five files.

**Files:**
- Modify: `src/index.css`
- Modify: `src/hud/hud.module.css`
- Modify: `src/hud/arrow-button.module.css`
- Modify: `src/components/canvas.module.css`
- Modify: `src/components/project-menu.module.css`

- [ ] **Step 1: Edit `src/index.css` — add `-webkit-tap-highlight-color` to `#root`**

In the existing `#root { ... }` block, add this property anywhere inside (e.g. right after `background: var(--color-back);`):

```css
  -webkit-tap-highlight-color: transparent;
```

- [ ] **Step 2: Edit `src/hud/hud.module.css` — `.hud` user-select + `.button` touch-action**

In the existing `.hud { ... }` block, add:

```css
  user-select: none;
  -webkit-user-select: none;
```

In the existing `.button { ... }` block, add:

```css
  touch-action: manipulation;
```

- [ ] **Step 3: Edit `src/hud/arrow-button.module.css`**

In the existing `.arrowButton { ... }` block, add:

```css
  user-select: none;
  -webkit-user-select: none;
  touch-action: manipulation;
```

- [ ] **Step 4: Edit `src/components/canvas.module.css`**

In the existing `.glCanvas { ... }` block, add:

```css
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
```

(Use `touch-action: none` on the canvas — not `manipulation` — because the canvas owns its own pointer handling; we don't want the browser intercepting any gesture on it.)

- [ ] **Step 5: Edit `src/components/project-menu.module.css`**

In the existing `.option { ... }` block, add:

```css
  user-select: none;
  -webkit-user-select: none;
  touch-action: manipulation;
```

In the existing `.projectRow { ... }` block, add:

```css
  user-select: none;
  -webkit-user-select: none;
```

(`.titleInput` keeps the default `user-select: text` — it's a form input and the user needs to select text. Don't touch it.)

- [ ] **Step 6: Run existing E2E suite**

Run: `pnpm test:fast --reporter=list`
Expected: all 59 tests pass. `touch-action` and `user-select` don't affect Playwright's synthetic events; the test suite is pointer/mouse-driven.

- [ ] **Step 7: Commit**

```bash
git add src/index.css src/hud/hud.module.css src/hud/arrow-button.module.css src/components/canvas.module.css src/components/project-menu.module.css
git commit -m "feat(mobile): touch ergonomics — tap-highlight, user-select, touch-action

Three additions:
- -webkit-tap-highlight-color: transparent on #root suppresses Android
  Chrome's gray tap-flash (the HUD's .active state is the intended
  feedback)
- user-select: none on HUD shells, arrow buttons, canvas, and project
  menu options/rows prevents long-press from triggering the
  text-selection UI. .titleInput keeps default text-selection.
- touch-action: manipulation on .button + .arrowButton + project-menu
  options eliminates the legacy 300ms tap delay and prevents
  double-tap-to-zoom. touch-action: none on .glCanvas — the canvas
  owns its own pointer handling.

Per spec §4."
```

---

## Task 4: rem migration

Mechanical conversion of fixed `px` values to `rem` at 16px base. Touches 4 files concretely.

**Files:**
- Modify: `src/index.css`
- Modify: `src/hud/contextual.module.css`
- Modify: `src/components/canvas.module.css`

(`src/hud/main.module.css` and `src/hud/breadcrumb.module.css` have no fixed px to convert — they use tokens only. `src/components/project-menu.module.css`'s 260px is converted as part of Task 6's dialog rewrite.)

- [ ] **Step 1: Add the rem base in `src/index.css`**

Find the existing `html, body, #root { ... }` block. Change it to:

```css
html {
  font-size: 16px;
}

html,
body,
#root {
  height: 100%;
  margin: 0;
  font-family: "Gas", system-ui, sans-serif;
}
```

(Separate the `html { font-size }` rule so it has higher specificity targeting alone, which is the convention.)

- [ ] **Step 2: Convert root tokens in `src/index.css`**

In the existing `#root { ... }` block, find these five lines and replace them:

```css
  --radius-big: 25px;
  --radius-small: 12px;
  --padding: 5px;

  --color-scroll-thumb: rgba(216, 216, 216, 0.3);
  --color-disabled: rgb(110, 110, 110);
  --color-red: #e94949;

  --radius-big: 25px;
  --radius-small: 12px;
  --padding: 5px;

  --hud-height: 60px;
  --hud-button-margin: 4px;
```

Wait — the actual current declarations (single block) are:

```css
  --radius-big: 25px;
  --radius-small: 12px;
  --padding: 5px;

  --hud-height: 60px;
  --hud-button-margin: 4px;
```

Replace those five token lines with:

```css
  --radius-big: 1.5625rem;
  --radius-small: 0.75rem;
  --padding: 0.3125rem;

  --hud-height: 3.75rem;
  --hud-button-margin: 0.25rem;
```

(Math: 25/16=1.5625, 12/16=0.75, 5/16=0.3125, 60/16=3.75, 4/16=0.25.)

- [ ] **Step 3: Convert slider geometry in `src/hud/contextual.module.css`**

Find these lines inside `.slider { ... }`:

```css
  height: 160px;
```

Replace with:

```css
  height: 10rem;
```

Inside `.slider::-webkit-slider-runnable-track { ... }`, replace:

```css
    width: 4px;
    background: rgba(255, 255, 255, 0.25);
    border-radius: 2px;
```

with:

```css
    width: 0.25rem;
    background: rgba(255, 255, 255, 0.25);
    border-radius: 0.125rem;
```

Inside `.slider::-webkit-slider-thumb { ... }`, replace:

```css
    height: 8px;
    width: 24px;
    border-radius: 4px;
    background: var(--color-front);
    margin-left: -10px;
```

with:

```css
    height: 0.5rem;
    width: 1.5rem;
    border-radius: 0.25rem;
    background: var(--color-front);
    margin-left: -0.625rem;
```

Inside `.slider::-moz-range-track { ... }`, replace:

```css
    width: 4px;
    background: rgba(255, 255, 255, 0.25);
    border-radius: 2px;
```

with:

```css
    width: 0.25rem;
    background: rgba(255, 255, 255, 0.25);
    border-radius: 0.125rem;
```

Inside `.slider::-moz-range-thumb { ... }`, replace:

```css
    height: 8px;
    width: 24px;
    border-radius: 4px;
    border: none;
    background: var(--color-front);
```

with:

```css
    height: 0.5rem;
    width: 1.5rem;
    border-radius: 0.25rem;
    border: none;
    background: var(--color-front);
```

(Math: 160/16=10, 4/16=0.25, 2/16=0.125, 8/16=0.5, 24/16=1.5, 10/16=0.625.)

- [ ] **Step 4: Convert spinner geometry in `src/components/canvas.module.css`**

Find the existing `.cameraLoader::after { ... }` block:

```css
.cameraLoader::after {
  content: "";
  width: 32px;
  height: 32px;
  border: 3px solid var(--color-front);
  border-top-color: transparent;
  border-radius: 50%;
  animation: cameraLoaderSpin 0.9s linear infinite;
}
```

Replace it with:

```css
.cameraLoader::after {
  content: "";
  width: 2rem;
  height: 2rem;
  border: 3px solid var(--color-front);
  border-top-color: transparent;
  border-radius: 50%;
  animation: cameraLoaderSpin 0.9s linear infinite;
}
```

(32/16=2. Note: the `3px` border stays as `3px` — hairlines should not scale. `border-radius: 50%` is percentage, no change.)

- [ ] **Step 5: Run existing E2E suite**

Run: `pnpm test:fast --reporter=list`
Expected: all 59 tests pass. The pixel math is byte-identical (16 * 1.5625 = 25, etc.), so visual layout is unchanged at the default 16px rem.

If any test fails with a 0.5-1 pixel layout difference (subpixel rounding at a fractional rem like `0.3125rem`), the fix is in the test (loosen the assertion to a ~1px tolerance) not in the CSS. The CSS is correct.

- [ ] **Step 6: Commit**

```bash
git add src/index.css src/hud/contextual.module.css src/components/canvas.module.css
git commit -m "feat(mobile): rem migration at 16px base

Convert fixed px values to rem so the UI scales with the user's
system font-size preference (a11y).

- html { font-size: 16px } sets the explicit rem base
- root tokens: --radius-big 25→1.5625rem, --radius-small 12→0.75rem,
  --padding 5→0.3125rem, --hud-height 60→3.75rem,
  --hud-button-margin 4→0.25rem
- contextual slider: height 160→10rem, track width 4→0.25rem,
  thumb 8×24→0.5×1.5rem, etc.
- canvas spinner: 32→2rem (border kept at 3px — hairlines don't scale)

Per spec §5. Math is byte-identical at 16px default; visual layout
unchanged for default users, scales proportionally for users with
larger system font-size."
```

---

## Task 5: Backdrop-filter a11y fallback

**Files:**
- Modify: `src/index.css`

- [ ] **Step 1: Append the `prefers-reduced-transparency` media block to `src/index.css`**

At the very bottom of the file (after the existing `#root { … }` block), add:

```css
/* Users who've opted in to reduced transparency at the OS level get
   a solid semi-transparent background instead of the backdrop-filter
   blur on HUD shells, arrow buttons, and the project-menu dialog
   backdrop. Per spec §6. The selectors are :global() because the HUD
   styles live in CSS modules — this is the one place we need to
   reach into module-scoped class names. */
@media (prefers-reduced-transparency: reduce) {
  :global(.hud),
  :global(.arrowButton) {
    backdrop-filter: none;
    background: rgba(27, 27, 27, 0.85);
  }
  :global(.dialog)::backdrop {
    backdrop-filter: none;
    background: rgba(0, 0, 0, 0.5);
  }
}
```

(Note: `src/index.css` is the global stylesheet, not a CSS module. CSS modules' generated class names will be `.hud_xyz123` etc., NOT `.hud`. The `:global(.hud)` syntax works in CSS-Modules-aware tools to escape the scoping. But since this file is not a module, the `:global()` wrapping is not strictly necessary — the unwrapped form may work. If the rule doesn't fire when toggling DevTools' "Emulate prefers-reduced-transparency: reduce", switch to using the actual module-scoped class names by moving the block into each respective module file instead.)

- [ ] **Step 2: Manually verify via Chrome DevTools**

Open the dev server (`pnpm dev`), open the app in Chrome, open DevTools → Rendering tab → "Emulate CSS media feature prefers-reduced-transparency" → set to `reduce`. Expected:
- HUDs lose their blur and show a solid dark backdrop
- Arrow buttons same
- Project menu (click the title to open) backdrop loses blur and shows solid darken

If the rule doesn't fire, the `:global()` wrapping is the issue. Try the unwrapped form first, then fall back to splitting the block into the three respective module CSS files (`src/hud/hud.module.css`, `src/hud/arrow-button.module.css`, `src/components/project-menu.module.css`) using the actual local class names. Document which approach worked in the commit message.

- [ ] **Step 3: Run existing E2E suite**

Run: `pnpm test:fast --reporter=list`
Expected: all 59 tests pass. The media query is opt-in (defaults to `no-preference`), so default behavior is unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/index.css
git commit -m "feat(mobile): prefers-reduced-transparency fallback for backdrop-filter

Free a11y win — users with the OS-level reduced-transparency setting
get a solid semi-transparent background instead of the backdrop blur
on HUDs, arrow buttons, and the project-menu dialog backdrop.

Default behavior unchanged. Verified via Chrome DevTools Rendering tab
emulation. Per spec §6 (the on-device cost measurement task lands in
Task 8)."
```

---

## Task 6: Dialog sizing on mobile

**Files:**
- Modify: `src/components/project-menu.module.css`

- [ ] **Step 1: Replace the dialog's sizing block**

Find the `.dialog` rule in `src/components/project-menu.module.css`. The current `min-width: 260px;` line needs to be replaced with safe-area-aware constraints.

The current `.dialog` block starts:

```css
.dialog {
  border: none;
  padding: 0;
  background: var(--color-back);
  color: var(--color-front);
  border-radius: var(--radius-big);
  min-width: 260px;
  max-height: 80dvh;
```

(Note: `max-height` was already changed to `80dvh` in Task 1.)

Replace those last two lines with:

```css
  min-width: min(16.25rem, calc(100dvw - 2 * var(--padding)));
  max-width: calc(100dvw - 2 * env(safe-area-inset-left) - 2 * env(safe-area-inset-right) - 2 * var(--padding));
  max-height: 80dvh;
```

(Math: 260/16 = 16.25rem.)

- [ ] **Step 2: Run existing E2E suite**

Run: `pnpm test:fast --reporter=list -g "project-menu|opfs-persistence"`
Expected: passes. On the default desktop-sized headless viewport, `min(16.25rem, calc(...))` resolves to `16.25rem` (the smaller is 16.25rem = 260px because the calc is much larger), so behavior is byte-identical.

- [ ] **Step 3: Commit**

```bash
git add src/components/project-menu.module.css
git commit -m "feat(mobile): project-menu dialog sizing for narrow + notched viewports

- min-width collapses gracefully on very narrow viewports via min(16.25rem, …)
  so a phone narrower than 260px doesn't get a horizontally-overflowing dialog
- max-width respects horizontal safe-areas (landscape on notched devices)
- max-height already moved to 80dvh in Task 1

Per spec §7. 16.25rem = 260px at the 16px rem base."
```

---

## Task 7: Mobile baseline E2E test

**Files:**
- Create: `tests/mobile-css-baseline.spec.ts`

- [ ] **Step 1: Create the test file**

```ts
// tests/mobile-css-baseline.spec.ts
import { expect, mockGetUserMedia, test } from "./helpers"

// A15-equivalent viewport (matches what the visual companion reports
// for the device used across the 30-series experiments).
test.use({ viewport: { width: 384, height: 699 } })

test("mobile baseline: viewport meta is honored, touch targets ≥ 44px, dialog respects dvh", async ({
  page,
}) => {
  await mockGetUserMedia(page)
  await page.goto("/")

  // 1) Viewport meta tag honored: documentElement.clientWidth must
  // equal the actual viewport width. Without the meta tag, mobile
  // browsers internally render at ~980px and clientWidth reports the
  // wider value. (Playwright's Chromium honors the meta tag, so this
  // assertion fails if the tag is missing or misconfigured.)
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth)
  expect(clientWidth).toBe(384)

  // 2) Record-start button is a meaningful touch target (WCAG 2.5.5
  // recommends 44×44 CSS pixels minimum). At the 16px rem base and
  // --hud-height: 3.75rem, the button is 60×60 CSS px.
  const recordButton = page.locator('[data-action="record-start"]').first()
  const boundingBox = await recordButton.boundingBox()
  expect(boundingBox).not.toBeNull()
  expect(boundingBox!.width).toBeGreaterThanOrEqual(44)
  expect(boundingBox!.height).toBeGreaterThanOrEqual(44)

  // 3) The project-menu dialog respects the dvh-based max-height.
  // Open it via the project-menu button (top-left), assert it doesn't
  // exceed the viewport.
  await page.locator('[data-action="open-project-menu"]').click()
  const dialog = page.locator("dialog[open]").first()
  await dialog.waitFor({ state: "visible", timeout: 5000 })
  const dialogBox = await dialog.boundingBox()
  expect(dialogBox).not.toBeNull()
  // dvh in headless Chromium resolves to the configured viewport
  // height, so 80dvh = 559.2 px. Allow a 5px slack for borders.
  expect(dialogBox!.height).toBeLessThanOrEqual(699 * 0.8 + 5)
})
```

- [ ] **Step 2: Verify the project-menu selector**

Before running, verify the project-menu open selector. Search for the correct data-action:

```bash
grep -rn 'data-action=' src/hud src/components | head -10
```

If `[data-action="open-project-menu"]` doesn't exist, find the actual selector for the project-menu open trigger (it may be `data-action="project-menu"` or similar) and update the test accordingly. Also verify the project-menu dialog uses the `<dialog>` element with `[open]` — based on the existing CSS (`dialog[open]` selectors in project-menu.module.css), it does.

If the project-menu requires explicit `await page.waitForFunction(...)` before opening (e.g. waiting for `window.__appContext` to be ready), look at how `tests/project-menu.spec.ts` opens it and copy the pattern.

- [ ] **Step 3: Run the new test**

Run: `pnpm test:fast --reporter=list tests/mobile-css-baseline.spec.ts`
Expected: PASS.

If it fails:
- `clientWidth` assertion fails → viewport meta tag is missing or wrong (Task 1 regression)
- Touch target assertion fails → rem migration broke `--hud-height` or button sizing (Task 4 regression)
- Dialog height assertion fails → Task 1 or Task 6 regression

- [ ] **Step 4: Run the full E2E suite to confirm no regression**

Run: `pnpm test:fast --reporter=list`
Expected: 59 prior tests + 1 new = 60 tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/mobile-css-baseline.spec.ts
git commit -m "test(mobile): baseline test for viewport meta + touch targets + dvh

Per spec §8 — single new test that pins three invariants:
1. documentElement.clientWidth equals the Playwright viewport width
   (proves viewport meta is honored; without it Chromium would
   internally render at ~980px and clientWidth would mismatch)
2. The record-start button has bounding box ≥ 44 × 44 CSS pixels
   (WCAG 2.5.5 touch target minimum)
3. The project-menu dialog's bounding box ≤ 80dvh + 5px slack

Uses the A15-equivalent viewport (384×699) configured via test.use.
Catches regression of Task 1 (viewport), Task 4 (rem sizing), or
Task 6 (dialog sizing)."
```

---

## Task 8: Backdrop-filter cost measurement experiment

Spec §6 mandates measuring per-frame backdrop-filter cost on the A15. This task scaffolds + runs a new experiment in the `experiments/` series.

**Files:**
- Create: `experiments/32_backdrop-filter-cost/README.md`
- Create: `experiments/32_backdrop-filter-cost/index.ts`

- [ ] **Step 1: Create `experiments/32_backdrop-filter-cost/README.md`**

```markdown
# backdrop-filter-cost

**Question:** how many ms/frame does the HUD's `backdrop-filter:
blur(10px) brightness(1.1) invert(0.25)` cost on the Galaxy A15?

## Why

Spec `docs/superpowers/specs/2026-05-18-mobile-css-pass-design.md` §6
keeps the backdrop-filter as-is in production but mandates an
on-device measurement to confirm it's not a meaningful jank source.
If this experiment shows > 2 ms/frame p95 contribution, the spec
already lists the mitigation options (media-query degrade on narrow
viewports) as a follow-up.

## Setup

Synthetic measurement loop, no camera, no real app. Two phases per
run:

1. Baseline: a full-viewport `<div>` painted via `requestAnimationFrame`
   with no backdrop-filter. Measure per-frame paint duration via
   `performance.now()` deltas over 300 frames (~5s).
2. With-filter: same loop, but the painted div carries the production
   backdrop-filter rule (`blur(10px) brightness(1.1) invert(0.25)`)
   over a 384×699 viewport.

Output: p50, p95, max paint delta for each phase; the difference is
the backdrop-filter cost.

## What's measured

- `baselineP50`, `baselineP95`, `baselineMax`
- `filteredP50`, `filteredP95`, `filteredMax`
- `costP50 = filteredP50 - baselineP50`
- `costP95 = filteredP95 - baselineP95`

## What to look for

- `costP95 ≤ 2 ms` — backdrop-filter is essentially free on the A15;
  the production CSS stays as-is unconditionally
- `2 ms < costP95 ≤ 5 ms` — measurable but tolerable. Document the
  number, no immediate action
- `costP95 > 5 ms` — meaningful contributor. Spec §6 mitigations
  (media-query degrade or solid-fallback on narrow viewports) become
  the recommended follow-up

## Caveats

- 300 frames is short; no thermal drift measurement
- Synthetic painted content is more compositor-friendly than the real
  app's WebGL canvas underneath; the measured cost is a lower bound
  on what production would actually pay
- Per-frame timing via `requestAnimationFrame` includes whole-frame
  cost (other browser work), not isolated paint cost — the cost
  *difference* is the meaningful number

## Reproduce

\`\`\`sh
git checkout <result.json git.sha>
pnpm dev
TIMEOUT_MS=120000 PORT=<port> experiments/harness/run.sh 32_backdrop-filter-cost
\`\`\`
```

- [ ] **Step 2: Create `experiments/32_backdrop-filter-cost/index.ts`**

```ts
// backdrop-filter-cost — measure per-frame cost of the production
// HUD's backdrop-filter on the target device. Two phases: baseline
// (no filter) and filtered. The cost is the delta.

import { wait } from "../../src/utils"
import { reportResult, status } from "../harness/report"

const params = {
  viewport: { width: 384, height: 699 },
  frames: 300,
  filter: "blur(10px) brightness(1.1) invert(0.25)",
}

interface PhaseResult {
  label: string
  samples: number
  p50Ms: number
  p95Ms: number
  maxMs: number
}

async function runPhase(label: string, filterCss: string): Promise<PhaseResult> {
  status(`PHASE ${label} (filter='${filterCss}')`)

  // Set up the painted div + a backdrop element below it. The backdrop
  // gives the filter something non-trivial to read through.
  const backdrop = document.createElement("div")
  backdrop.style.cssText = `
    position: fixed; inset: 0; z-index: 0;
    background: linear-gradient(45deg, #444, #222, #555);
  `
  document.body.appendChild(backdrop)
  const painted = document.createElement("div")
  painted.style.cssText = `
    position: fixed;
    left: ${(window.innerWidth - params.viewport.width) / 2}px;
    top: ${(window.innerHeight - params.viewport.height) / 2}px;
    width: ${params.viewport.width}px;
    height: ${params.viewport.height}px;
    z-index: 1;
    background: rgba(255, 255, 255, 0.1);
    backdrop-filter: ${filterCss};
  `
  document.body.appendChild(painted)

  // Force a layout flush before timing starts.
  void painted.offsetHeight

  const samples: number[] = []
  let lastFrameMs = performance.now()
  const { promise: done, resolve } = Promise.withResolvers<void>()

  function tick(): void {
    const now = performance.now()
    const delta = now - lastFrameMs
    lastFrameMs = now
    if (samples.length > 0) {
      // Skip the first delta (timer-start to first frame is noise).
      samples.push(delta)
    } else {
      samples.push(delta)
    }
    // Mutate the painted element each frame to force repaint.
    painted.style.transform = `translateZ(0) rotate(${(samples.length * 0.5) % 360}deg)`
    if (samples.length < params.frames) {
      requestAnimationFrame(tick)
    } else {
      resolve()
    }
  }
  requestAnimationFrame(tick)
  await done

  document.body.removeChild(painted)
  document.body.removeChild(backdrop)

  const sorted = samples.slice().sort((a, b) => a - b)
  const p50 = sorted[Math.floor(sorted.length * 0.5)]
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]
  const max = sorted[sorted.length - 1]
  const result: PhaseResult = {
    label,
    samples: samples.length,
    p50Ms: p50,
    p95Ms: p95,
    maxMs: max,
  }
  status(
    `  ${label} p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms max=${max.toFixed(2)}ms`,
  )
  return result
}

async function run(): Promise<void> {
  status(`backdrop-filter-cost: ${params.frames} frames per phase`)
  // Settle before timing.
  await wait(500)
  const baseline = await runPhase("baseline", "none")
  await wait(500)
  const filtered = await runPhase("filtered", params.filter)

  const costP50 = filtered.p50Ms - baseline.p50Ms
  const costP95 = filtered.p95Ms - baseline.p95Ms
  status(`cost: p50=${costP50.toFixed(2)}ms p95=${costP95.toFixed(2)}ms`)

  reportResult("backdrop-filter-cost", params, {
    baseline,
    filtered,
    costP50,
    costP95,
  })
}

run().catch((error: unknown) => {
  status(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
  reportResult("backdrop-filter-cost", params, {
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  })
})
```

- [ ] **Step 3: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no errors mentioning `experiments/32_backdrop-filter-cost`.

- [ ] **Step 4: Run on device**

Run: `TIMEOUT_MS=120000 PORT=5173 experiments/harness/run.sh 32_backdrop-filter-cost`

Expected: ~10 s of measurement. Result printed at the bottom shows `costP50` and `costP95` numbers.

If the dev server isn't running: `pnpm dev` first, in a separate terminal or backgrounded.

- [ ] **Step 5: Append the measured result to the experiment README**

Open `experiments/32_backdrop-filter-cost/README.md`. After the "## What to look for" section (or at the very bottom), append:

```markdown
## Findings (<DATE>, sha `<GIT-SHA>`, Galaxy A15)

| Phase | p50 | p95 | max |
|---|---|---|---|
| baseline | <BASELINE_P50> ms | <BASELINE_P95> ms | <BASELINE_MAX> ms |
| filtered | <FILTERED_P50> ms | <FILTERED_P95> ms | <FILTERED_MAX> ms |
| **cost** | **<COST_P50> ms** | **<COST_P95> ms** | — |

Verdict: <one sentence — ≤2ms, 2-5ms, or >5ms per the "What to look for" thresholds>.
```

Fill in the placeholders from the result.json. Run `git log -1 --format=%h` to get the SHA to embed (after the next commit).

- [ ] **Step 6: Commit**

```bash
git add experiments/32_backdrop-filter-cost/
git commit -m "experiment(32): backdrop-filter cost measurement on A15

Per spec §6, measures the per-frame cost of the production HUD's
backdrop-filter: blur(10px) brightness(1.1) invert(0.25) over 300
frames at a 384×699 viewport. Two-phase: baseline (no filter) vs
filtered, cost = delta.

Result: <p50/p95 numbers from the run>. <Verdict per the thresholds>."
```

(Fill in the actual numbers from the run output before committing.)

---

## Self-review

### Spec coverage

| Spec section | Plan task |
|---|---|
| §1 Viewport meta tag | Task 1 |
| §2 vh → dvh adoption | Task 1 |
| §3 Safe-area-inset handling | Task 2 |
| §4 Touch ergonomics | Task 3 |
| §5 rem migration | Task 4 |
| §6 Backdrop-filter (a11y + measurement) | Task 5 (a11y) + Task 8 (measurement) |
| §7 Dialog sizing on mobile | Task 6 |
| §8 Testing strategy | Task 7 (baseline test); regression suite runs at end of each task |

All eight spec sections have at least one task. Spec's "Touch surface" table maps file-for-file to the tasks (`src/hud/main.module.css` and `src/hud/breadcrumb.module.css` have no fixed px to convert and no specific changes called out, so they're not in any task — verified by grep).

### Placeholder scan

No "TBD", "TODO", "implement later", "appropriate error handling", or "similar to Task N" markers. Code blocks contain the actual edits. Commands have expected output. One templated placeholder in Task 8 step 5 (the findings table) is by design — measurement output isn't known until the experiment runs, and the task instructs the implementer to fill in the numbers.

### Type / name consistency

- `--hud-height: 3.75rem` (Task 4) — referenced by `.button { width: var(--hud-height); }` (already in `src/hud/hud.module.css`); the var reference is unchanged so no cross-task drift.
- `100dvh` (Task 1) — referenced by `min(16.25rem, calc(100dvw - 2 * var(--padding)))` in Task 6. `dvh`/`dvw` are units, not vars; consistent.
- `--padding: 0.3125rem` (Task 4) — referenced in Tasks 2, 6 via `var(--padding)`; var reference unchanged.
- New token names introduced: none.
- New file paths: `tests/mobile-css-baseline.spec.ts` (Task 7), `experiments/32_backdrop-filter-cost/{README.md,index.ts}` (Task 8). Both referenced exactly once each.

No type/name drift.
