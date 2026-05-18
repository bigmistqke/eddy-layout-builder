# Mobile CSS Pass — Design

**Date:** 2026-05-18
**Status:** active
**Related:** all `*.css` / `*.module.css` files under `src/`; `index.html`

## Scope

Convert eddy's CSS from a desktop-assumed layout to a mobile-first one driven by the Galaxy A15 target (the device already used for the entire video pipeline — phase 1/2/3 specs, experiments 30 series). Desktop must still work but doesn't drive sizing decisions.

The user opened this work observing that "the UI looks very small on mobile" and "the vh does not take into consideration mobile viewports." Root-cause analysis identified eight discrete issues; this spec addresses all eight in one pass.

## Evidence anchoring

CSS audit performed against the current `main` (post phase-3 merge) revealed:

| Symptom | Root cause | Section |
|---|---|---|
| Whole UI scales down ~3× on mobile | No `<meta name="viewport">` in `index.html`; mobile browsers default to ~980px and scale-to-fit | §1 |
| Bottom HUD clips below visible viewport when URL bar is shown | `height: 100vh` on `#root` ignores URL bar; `max-height: 80vh` on project-menu dialog same issue | §2 |
| Top/bottom HUDs collide with notches + home indicator on notched devices | No `env(safe-area-inset-*)` handling | §3 |
| Long-press on canvas triggers text selection / image-save UI; HUD buttons tap-flash on Android | No `touch-action`, `user-select`, or `-webkit-tap-highlight-color` rules | §4 |
| UI doesn't scale with user's system font-size preference (a11y) | All sizing in fixed `px` (`--hud-height: 60px`, `--radius-big: 25px`, etc.) | §5 |
| Backdrop-filter blur + brightness + invert on every HUD shell may cost ~5-10ms/frame on A15 | Universally applied without measurement or a11y fallback | §6 |
| Project-menu dialog uses fixed `min-width: 260px` with no safe-area awareness | Hard-coded width clips on narrow / notched viewports | §7 |
| No automated guard against the viewport meta tag being regressed | No test exists | §8 |

## What stays the same

- Visual language: dark theme, blur-backdrop HUDs, rounded `--radius-big`/`--radius-small` corners
- The 3×3 grid HUD overlay model (`.hudOverlay`)
- All component layouts, HUD positions, and button placement
- The slider's `writing-mode: vertical-lr` vertical-orientation trick
- The custom "Gas" font
- All CSS color tokens

This is a sizing / units / robustness pass, not a redesign.

## What changes

### §1 — Viewport meta tag

Add to `index.html`:

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
```

`viewport-fit=cover` enables `env(safe-area-inset-*)` for §3.

### §2 — `vh` → `dvh` adoption

Per the user choice (HUD should follow the URL bar for max canvas space):

- `index.html`: `<div id="root" style="…;height:100vh">` → `100dvh`
- `src/components/project-menu.module.css`: `.dialog { max-height: 80vh }` → `80dvh`

`100vw` stays as-is (no mobile equivalent issue). No `svh` use.

### §3 — Safe-area-inset handling

In `src/layout-builder.module.css`'s `.hudOverlay`:

```css
padding:
  max(var(--padding), env(safe-area-inset-top))
  max(var(--padding), env(safe-area-inset-right))
  max(var(--padding), env(safe-area-inset-bottom))
  max(var(--padding), env(safe-area-inset-left));
```

In `src/hud/hud.module.css`'s `.bottomCenter`:

```css
bottom: max(var(--padding), env(safe-area-inset-bottom));
```

`max()` ensures the spacing never drops below the original `--padding` on non-notched devices; `env()` returns 0 on those.

### §4 — Touch ergonomics

Three additions:

- `touch-action: manipulation` on `.glCanvas` (in `src/components/canvas.module.css`) and on `.button` rules under `src/hud/hud.module.css`, `src/components/project-menu.module.css`. Eliminates the legacy 300ms tap delay and prevents double-tap-to-zoom on buttons.
- `user-select: none` on `.glCanvas`, the `.hud` shell, `.arrowButton`, and the project-menu `.option`/`.projectRow` siblings. `.titleInput` keeps the default `user-select: text` since it's a form field.
- `-webkit-tap-highlight-color: transparent` on `#root` in `src/index.css`. Kills the Android Chrome gray-flash on tap; the HUD's existing `.active` state is the intended visual feedback.

### §5 — rem migration (mechanical)

Set `html { font-size: 16px }` in `src/index.css` so we have a stable rem base.

Convert all fixed `px` values to `rem` at 16px base. Root tokens:

| Token | Before | After |
|---|---|---|
| `--radius-big` | `25px` | `1.5625rem` |
| `--radius-small` | `12px` | `0.75rem` |
| `--padding` | `5px` | `0.3125rem` |
| `--hud-height` | `60px` | `3.75rem` |
| `--hud-button-margin` | `4px` | `0.25rem` |

Same conversion for inline literals across all CSS files: slider thumb/track sizes, the 32px loader spinner, 160px slider height, 260px dialog `min-width`, etc.

**Exceptions:** `1px` borders stay as `1px` (hairlines should not scale); `border-radius: 50%` and percentage values are unaffected.

Net effect: users who've set a larger OS font-size (e.g. 20px instead of 16px) get UI scaled proportionally. Layout was already designed around proportional spacing so nothing visually regresses for the default user.

### §6 — Backdrop-filter (keep + a11y fallback + measurement)

Default behavior unchanged: keep `backdrop-filter: blur(10px) brightness(1.1) invert(0.25)` on `.hud`, `.arrowButton`, and `.dialog::backdrop`.

Add a `@media (prefers-reduced-transparency: reduce)` block in `src/index.css` that overrides the blur to a solid semi-transparent background on each affected selector:

```css
@media (prefers-reduced-transparency: reduce) {
  .hud, .arrowButton {
    backdrop-filter: none;
    background: rgba(27, 27, 27, 0.85);
  }
  .dialog::backdrop {
    backdrop-filter: none;
    background: rgba(0, 0, 0, 0.5);
  }
}
```

(Selectors may need to be referenced from the module CSS files via `:global()` since the HUD/arrow rules are CSS module-scoped. Implementation plan will resolve.)

In the implementation plan, the final task **measures the per-frame backdrop-filter cost on the A15** using the existing experiments harness — record-while-playing K=4 with HUD visible, compare jank metrics vs HUD hidden. If it's a meaningful contributor (>2ms p95), the spec already lists the mitigations (media-query degrade on narrow viewports) as a follow-up; we don't ship them preemptively.

### §7 — Dialog sizing on mobile

In `src/components/project-menu.module.css`'s `.dialog`:

```css
min-width: min(260px, calc(100dvw - 2 * var(--padding)));
max-width: calc(100dvw - 2 * env(safe-area-inset-left) - 2 * env(safe-area-inset-right) - 2 * var(--padding));
max-height: 80dvh;  /* swap from 80vh per §2 */
```

`min-width` collapses gracefully on very narrow viewports; `max-width` keeps the dialog inside safe-areas in landscape.

### §8 — Testing strategy

- **Regression:** all 59 existing E2E tests must still pass. rem migration + viewport meta shouldn't affect them (they run in headless Chromium at a fixed viewport); the test suite is the smoke check.
- **Per-section manual smoke** on the Galaxy A15 via the visual companion server. For each merged section, confirm on-device: text readable, HUD buttons at expected size, dialogs usable, bottom HUD clears the home indicator.
- **One new automated test** — `tests/mobile-css-baseline.spec.ts`:
  - Sets Playwright viewport to 384×699 (the A15 viewport per prior experiments)
  - Records a clip + opens the project menu
  - Asserts `document.documentElement.clientWidth === 384` (proves viewport meta is honored — without it, the page would internally be 980 wide)
  - Asserts the record-stop button rendered width ≥ 44 CSS pixels (WCAG touch-target minimum)
  - Asserts the dialog's `clientHeight` ≤ viewport `innerHeight` (proves dvh works)
- No new test for safe-area-inset — headless Chromium doesn't simulate notches; manual smoke covers it.

## Out of scope

- Visual redesign (colors, fonts, icons)
- Landscape orientation polish (eddy is portrait-first per the layout model)
- Tablet-specific breakpoints (mobile-first; tablets get the mobile layout up to their pixel widths)
- Replacement of `writing-mode: vertical-lr` slider with a different vertical-slider implementation
- Performance work on backdrop-filter beyond the measurement task (deferred unless measurement says otherwise)
- PWA / installability metadata
- Service-worker offline support
- Dark/light theme toggle (already dark-only)

## Touch surface

| File | Action |
|---|---|
| `index.html` | Add viewport meta tag; root div height `100vh` → `100dvh` |
| `src/index.css` | Add `html { font-size: 16px }`, `#root { -webkit-tap-highlight-color: transparent }`, rem-convert all `--*` tokens, add `prefers-reduced-transparency` media block |
| `src/layout-builder.module.css` | `.hudOverlay` padding gains safe-area-inset awareness; px → rem |
| `src/hud/hud.module.css` | `.bottomCenter` bottom gains safe-area-inset; `.button` touch-action + user-select; px → rem |
| `src/hud/main.module.css` | px → rem |
| `src/hud/breadcrumb.module.css` | px → rem |
| `src/hud/arrow-button.module.css` | user-select: none, touch-action; px → rem |
| `src/hud/contextual.module.css` | px → rem (slider thumb/track/height) |
| `src/components/canvas.module.css` | `.glCanvas` touch-action + user-select; px → rem (spinner size) |
| `src/components/project-menu.module.css` | dialog sizing (§7); options/rows user-select; px → rem; max-height 80vh → 80dvh |
| `tests/mobile-css-baseline.spec.ts` | New |

## Success criteria

- All 59 existing E2E tests pass.
- New test `tests/mobile-css-baseline.spec.ts` passes.
- On the Galaxy A15 via visual companion: app fills the screen, HUD buttons are ~60px on screen (matching desktop scale), bottom HUD clears the home indicator, project menu fits within the viewport.
- No measurable jank regression in the existing experiments harness (record-while-playing). Backdrop-filter measurement task produces a result number (recorded in a follow-up experiment README).
- `document.documentElement.clientWidth` on a 384px Playwright viewport equals 384 (proves viewport meta is in place).
- `prefers-reduced-transparency: reduce` swaps backdrop blur for solid bg on supported browsers (manual verification via Chrome DevTools toggle).

## Risks

- **rem migration produces subtle 0.5-1 px shifts** in layouts that depended on integer pixel math (e.g. a calc that used `5px` may now produce fractional pixels at sub-pixel rendering boundaries). Regression suite + manual smoke catches most; the WebGL canvas itself is unaffected (it renders to its own backbuffer).
- **`100dvh` causes the bottom HUD to slide during URL-bar collapse animations** — per user choice, accepted tradeoff. If on-device testing reveals it feels janky during the record-stop tap, the spec already documents the `svh` and hybrid alternatives.
- **`prefers-reduced-transparency` selectors are CSS-module-scoped**; `:global()` may be required or per-module media blocks. Implementation plan task decides which approach is cleaner.
- **Backdrop-filter measurement may reveal a real perf cost** on the A15, requiring follow-up mitigation. Spec explicitly defers that decision pending measurement.
- **No automated coverage for safe-area-inset behavior.** Manual smoke on a notched device is required. Mitigation: keep the `max(var(--padding), env(...))` pattern so non-notched devices get the original behavior — regression risk is bounded to notched devices.
- **Headless Chromium may not perfectly simulate the mobile viewport meta behavior** for the new baseline test. If `clientWidth === 384` doesn't hold reliably, fall back to checking that a known HUD button has expected CSS dimensions (proves no scale-down).
