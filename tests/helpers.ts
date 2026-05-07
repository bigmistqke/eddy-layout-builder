import type { Page } from "@playwright/test"

/** Click a frame by its layout path (e.g., [0, 1] → `[data-path="0.1"]`).
 *  Picks the leaf-most matching node (data-path is also set on container
 *  Frames; we want the rendered leaf for click hit-testing). */
export async function clickFrame(page: Page, path: number[], options?: { force?: boolean }) {
  const key = path.join(".")
  // `force` here means "dispatch a click event programmatically" — bypasses
  // Playwright's scroll-into-view requirement, which fails when the target
  // is panned outside the browser viewport by the canvas's CSS transform.
  if (options?.force) {
    await page.locator(`[data-path="${key}"]`).last().dispatchEvent("click")
    return
  }
  await page.locator(`[data-path="${key}"]`).last().click()
}

/** Click a breadcrumb segment by its depth. Segments are buttons inside the
 *  top-left breadcrumb notch, ordered root → leaf left-to-right (segment
 *  index i corresponds to depth path.length - i). Index by segment
 *  position, not depth, since the test author can read the button index
 *  directly from the DOM. */
export async function clickBreadcrumb(page: Page, segmentIndex: number) {
  // The breadcrumb is the only top-oriented Notch (`hudTop` modifier),
  // so scope button-nth lookup to that subtree.
  await page
    .locator('[class*="hudTop"] button')
    .nth(segmentIndex)
    .click()
}

/** Click a directional handle on a specific frame. The notch wrapper has
 *  zero in-flow size (children are absolutely positioned), so we click the
 *  visible inner `.notch-backdrop` via a child selector. */
export async function clickHandle(
  page: Page,
  framePath: number[],
  dir: "top" | "bottom" | "left" | "right",
  options?: { force?: boolean },
) {
  const key = framePath.join(".")
  const notch = page
    .locator(`[data-path="${key}"] [data-direction="${dir}"]`)
    .last()
  // The first child of the notch wrapper is .notch-backdrop, which has an
  // explicit width/height. The actual onClick handlers, however, live on
  // .notchBackdrop's children (.edge/.center/.root) — the notch wrapper
  // itself stopPropagation()s — so dispatchEvent must target a
  // .notchBackdrop child to fire the handler. Native click works against
  // .notchBackdrop because Playwright clicks at coordinates that resolve
  // to the deepest element under the cursor.
  if (options?.force) {
    await notch.locator("> div > div").first().dispatchEvent("click")
    return
  }
  await notch.locator("> div").first().click()
}

/** Click a UI action button by its data-action attribute. */
export async function clickAction(page: Page, action: string) {
  await page.locator(`[data-action="${action}"]`).first().click()
}

/** Activate an editing tool (`append` or `split`) — replaces the old
 *  "enter-layout" affordance. Tools toggle via the same button, so this
 *  also no-ops if the tool is already active (caller's responsibility to
 *  not call twice without intending a toggle). */
export async function activateTool(page: Page, tool: "append" | "split") {
  await clickAction(page, `set-tool-${tool}`)
}

/** Read the bounding box of a frame at a given path. Returns canvas-relative
 *  coords (frame.rect minus canvas.rect). */
export async function frameRect(page: Page, path: number[]) {
  const key = path.join(".")
  return page.evaluate(k => {
    const node = document.querySelector<HTMLElement>(`[data-path="${k}"]`)
    const canvas = document.querySelector<HTMLElement>('[data-canvas="true"]')
    if (!node || !canvas) return null
    const n = node.getBoundingClientRect()
    const c = canvas.getBoundingClientRect()
    return {
      x: n.left - c.left,
      y: n.top - c.top,
      w: n.width,
      h: n.height,
    }
  }, key)
}

/** Read the canvas's viewport transform (translate from the inline style on
 *  canvasInner). Returns the parsed {x, y, scale} as floats. */
export async function readViewport(page: Page) {
  return page.evaluate(() => {
    const inner = document.querySelector<HTMLElement>('[data-canvas-inner="true"]')
    if (!inner) return null
    const transform = inner.style.transform
    const widthPx = parseFloat(inner.style.width) || 0
    const m = transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/)
    return {
      x: m ? parseFloat(m[1]) : 0,
      y: m ? parseFloat(m[2]) : 0,
      width: widthPx,
      height: parseFloat(inner.style.height) || 0,
    }
  })
}

type Direction = "top" | "bottom" | "left" | "right"
type HandleOp = "split" | "append"

/** A logged user action — mirrors the JSON payloads emitted via logAction()
 *  in src/utils.ts. The types here cover what the test harness needs to
 *  replay; extend as new action kinds appear in the app. */
export type Action =
  | { type: "set-tool"; tool: "split" | "append" | null }
  | { type: "tap-frame"; path: number[] }
  | { type: "add-frame"; path: number[]; direction: Direction; op: HandleOp }
  | { type: "deselect" }
  | { type: "delete" }
  | { type: "tap-breadcrumb"; depth: number; segmentIndex: number }

/** Parse the `[action] {...}` lines that get printed to the browser console
 *  by logAction(). Useful when the user pastes a console log directly into
 *  a test — `runActions(page, raw)` will accept either a string or an
 *  Action[] and parse on the way in. */
export function parseActionLog(raw: string): Action[] {
  const actions: Action[] = []
  for (const line of raw.split("\n")) {
    const match = line.match(/\[action\]\s*(\{.*\})\s*$/)
    if (!match) {
      continue
    }
    actions.push(JSON.parse(match[1]) as Action)
  }
  return actions
}

/** Replay a sequence of actions against the page using the same helpers
 *  individual tests use. Waits `delayMs` after each step (default 300ms,
 *  matching the app's animation+settle window). String input is parsed
 *  via parseActionLog so a raw console log can be replayed verbatim. */
export async function runActions(
  page: Page,
  actions: Action[] | string,
  options: { delayMs?: number } = {},
) {
  const delayMs = options.delayMs ?? 300
  const list = typeof actions === "string" ? parseActionLog(actions) : actions
  for (const action of list) {
    switch (action.type) {
      case "set-tool":
        if (action.tool === null) {
          // Toggling the active tool sets it to null; the test author is
          // responsible for knowing which tool is currently active.
          throw new Error("set-tool with null is ambiguous; toggle the active tool explicitly")
        }
        await activateTool(page, action.tool)
        break
      case "tap-frame":
        // Force-dispatch — replayed sequences shouldn't fail because a
        // HUD or off-viewport position blocks hit-testing; the action log
        // already proves the click happened in the user's session.
        await clickFrame(page, action.path, { force: true })
        break
      case "add-frame":
        await clickHandle(page, action.path, action.direction, { force: true })
        break
      case "deselect":
        await clickAction(page, "deselect")
        break
      case "delete":
        await clickAction(page, "delete")
        break
      case "tap-breadcrumb":
        await clickBreadcrumb(page, action.segmentIndex)
        break
    }
    await page.waitForTimeout(delayMs)
  }
}

/** Assert the selected frame respects the zoom rules. Pass `mode` to
 *  pick the rule:
 *
 *    - "fit-inside"    — Rule 2: frame fits inside the target box on
 *                        BOTH axes; binding axis hits target exactly;
 *                        the other axis is strictly smaller. Frame is
 *                        centered in the canvas.
 *    - "clamp-overflow"— Rule 3: one axis hits target, the other axis
 *                        is LARGER than the canvas (extreme aspect
 *                        ratio fallback). Frame is centered.
 *    - "auto"          — accept either Rule 2 or Rule 3 outcome.
 *
 *  FRAME_PADDING and HUD-height assumptions match `src/constants.ts`
 *  (FRAME_PADDING = 2 * HANDLE_H = 96 with the current values).
 */
export async function expectFrameRespectsMargin(
  page: Page,
  mode: "fit-inside" | "clamp-overflow" | "auto" = "auto",
  options: { tolerance?: number; framePadding?: number } = {},
) {
  const tolerance = options.tolerance ?? 3
  const framePadding = options.framePadding ?? 96

  const result = await page.evaluate(() => {
    // The selected frame is the only one rendering handles.
    const handle = document.querySelector<HTMLElement>("[data-direction='bottom']")
    const selected = handle?.closest<HTMLElement>("[data-path]")
    const canvas = document.querySelector<HTMLElement>("[data-canvas='true']")
    if (!selected || !canvas) {
      return null
    }
    const s = selected.getBoundingClientRect()
    const c = canvas.getBoundingClientRect()
    return {
      frame: { x: s.left - c.left, y: s.top - c.top, w: s.width, h: s.height },
      canvas: { w: c.width, h: c.height },
    }
  })

  if (!result) {
    throw new Error(
      "expectFrameRespectsMargin: no selected frame found (no [data-direction='bottom'] handle in DOM)",
    )
  }

  const targetWidth = result.canvas.w - 2 * framePadding
  const targetHeight = result.canvas.h - 2 * framePadding
  const widthAtTarget = Math.abs(result.frame.w - targetWidth) < tolerance
  const heightAtTarget = Math.abs(result.frame.h - targetHeight) < tolerance

  if (!widthAtTarget && !heightAtTarget) {
    throw new Error(
      `expectFrameRespectsMargin: neither axis hit target. ${JSON.stringify(result)} ` +
        `target=${targetWidth}x${targetHeight}`,
    )
  }

  // Frame is centered in canvas.
  const frameCx = result.frame.x + result.frame.w / 2
  const frameCy = result.frame.y + result.frame.h / 2
  const dx = Math.abs(frameCx - result.canvas.w / 2)
  const dy = Math.abs(frameCy - result.canvas.h / 2)
  if (dx >= tolerance || dy >= tolerance) {
    throw new Error(
      `expectFrameRespectsMargin: frame not centered. dx=${dx}, dy=${dy}, ${JSON.stringify(result)}`,
    )
  }

  // Classify which rule applied: the non-binding axis is either
  // smaller than target (fit-inside) or larger than canvas (overflow).
  const nonBindingFitsInside = widthAtTarget
    ? result.frame.h < targetHeight - tolerance
    : result.frame.w < targetWidth - tolerance
  const nonBindingOverflows = widthAtTarget
    ? result.frame.h > result.canvas.h + tolerance
    : result.frame.w > result.canvas.w + tolerance

  const detected: "fit-inside" | "clamp-overflow" | "unknown" = nonBindingFitsInside
    ? "fit-inside"
    : nonBindingOverflows
      ? "clamp-overflow"
      : "unknown"

  if (detected === "unknown") {
    throw new Error(
      `expectFrameRespectsMargin: non-binding axis is neither fit-inside nor overflow. ${JSON.stringify(result)}`,
    )
  }
  if (mode !== "auto" && mode !== detected) {
    throw new Error(
      `expectFrameRespectsMargin: expected ${mode}, got ${detected}. ${JSON.stringify(result)}`,
    )
  }

  return { rule: detected, ...result }
}

/** Assert that all four selected-frame handles are visible inside the
 *  canvas viewport. A handle whose bounding rect lies entirely past a
 *  canvas edge isn't clickable by the user. Sticking and centering
 *  should keep handles within the canvas regardless of how far the
 *  selected frame overflows. */
export async function expectHandlesInViewport(page: Page) {
  const dump = await page.evaluate(() => {
    const rect = (element: Element | null | undefined) => {
      if (!element) {
        return null
      }
      const r = element.getBoundingClientRect()
      return { x: r.left, y: r.top, w: r.width, h: r.height }
    }
    const handles: Record<string, { x: number; y: number; w: number; h: number } | null> = {}
    for (const direction of ["top", "bottom", "left", "right"]) {
      const wrapper = document.querySelector(`[data-direction='${direction}']`)
      handles[direction] = rect(wrapper?.firstElementChild)
    }
    return {
      canvas: rect(document.querySelector("[data-canvas='true']")),
      handles,
    }
  })

  if (!dump.canvas) {
    throw new Error("expectHandlesInViewport: no [data-canvas='true'] element")
  }
  for (const [direction, r] of Object.entries(dump.handles)) {
    if (!r) {
      throw new Error(`expectHandlesInViewport: ${direction} handle missing`)
    }
    const offLeft = r.x + r.w < dump.canvas.x - 1
    const offRight = r.x > dump.canvas.x + dump.canvas.w + 1
    const offTop = r.y + r.h < dump.canvas.y - 1
    const offBottom = r.y > dump.canvas.y + dump.canvas.h + 1
    if (offLeft || offRight || offTop || offBottom) {
      throw new Error(
        `expectHandlesInViewport: ${direction} handle is outside the canvas viewport: ${JSON.stringify({ handle: r, canvas: dump.canvas })}`,
      )
    }
  }
}

/** Assert that the four selected-frame handles don't overlap each
 *  other and don't sit entirely behind any HUD. The "tip past HUD"
 *  check uses the canvas-center-facing edge of each handle: if a HUD
 *  overlaps the handle, the handle's inward edge must be past the
 *  HUD's frame-side edge (so a clickable strip is visible). */
export async function expectHandlesDontOverlap(page: Page) {
  const dump = await page.evaluate(() => {
    const rect = (element: Element | null | undefined) => {
      if (!element) {
        return null
      }
      const r = element.getBoundingClientRect()
      return { x: r.left, y: r.top, w: r.width, h: r.height }
    }
    const handles: Record<string, { x: number; y: number; w: number; h: number } | null> = {}
    for (const direction of ["top", "bottom", "left", "right"]) {
      const wrapper = document.querySelector(`[data-direction='${direction}']`)
      handles[direction] = rect(wrapper?.firstElementChild)
    }
    const huds: Record<string, { x: number; y: number; w: number; h: number } | null> = {
      mainBottom: rect(
        document.querySelector("[data-action='set-tool-append']")?.closest("[class*='_notch_']"),
      ),
      contextualRight: rect(
        document.querySelector("[data-action='deselect']")?.closest("[class*='_notch_']"),
      ),
      breadcrumbTop: rect(document.querySelector("[class*='hudTop']")),
    }
    return { handles, huds }
  })

  for (const [direction, r] of Object.entries(dump.handles)) {
    if (!r) {
      throw new Error(`expectHandlesDontOverlap: ${direction} handle missing`)
    }
    if (r.w <= 0 || r.h <= 0) {
      throw new Error(`expectHandlesDontOverlap: ${direction} handle has zero area`)
    }
  }

  type Rect = { x: number; y: number; w: number; h: number }
  const overlaps = (a: Rect, b: Rect) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

  const handleList = Object.entries(dump.handles).map(([direction, r]) => ({
    direction,
    rect: r as Rect,
  }))
  for (let i = 0; i < handleList.length; i++) {
    for (let j = i + 1; j < handleList.length; j++) {
      const a = handleList[i]
      const b = handleList[j]
      if (overlaps(a.rect, b.rect)) {
        throw new Error(
          `expectHandlesDontOverlap: ${a.direction} overlaps ${b.direction}: ${JSON.stringify({ a: a.rect, b: b.rect })}`,
        )
      }
    }
  }

  function tipPastHud(handleRect: Rect, hudRect: Rect, direction: string): boolean {
    switch (direction) {
      case "top":
        return handleRect.y + handleRect.h > hudRect.y + hudRect.h
      case "bottom":
        return handleRect.y < hudRect.y
      case "left":
        return handleRect.x + handleRect.w > hudRect.x + hudRect.w
      case "right":
        return handleRect.x < hudRect.x
      default:
        return true
    }
  }
  for (const [hudName, hudRect] of Object.entries(dump.huds)) {
    if (!hudRect) {
      continue
    }
    for (const handle of handleList) {
      if (!overlaps(handle.rect, hudRect)) {
        continue
      }
      if (!tipPastHud(handle.rect, hudRect, handle.direction)) {
        throw new Error(
          `expectHandlesDontOverlap: ${handle.direction} handle is entirely behind ${hudName} HUD: ${JSON.stringify({ handle: handle.rect, hud: hudRect })}`,
        )
      }
    }
  }
}

/** Drain console logs emitted via [action] tags into an in-memory list.
 *  Returns a function that gives you the current list. */
export function captureActionLog(page: Page) {
  const log: string[] = []
  page.on("console", msg => {
    const text = msg.text()
    if (text.startsWith("[action]")) log.push(text)
  })
  return {
    get: () => log.slice(),
    clear: () => {
      log.length = 0
    },
  }
}
