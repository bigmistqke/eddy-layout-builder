import type { Page } from "@playwright/test"

/**
 * Inject a fake `navigator.mediaDevices.getUserMedia` that returns a
 * MediaStream captured from a looped <video> element pointed at our
 * fixture clip. Headless Chromium's `--use-fake-device-for-media-stream`
 * lists fake devices via `enumerateDevices` but rejects `getUserMedia`
 * with `NotSupportedError`, so we can't rely on it. Call once before
 * `page.goto` (via `page.addInitScript`).
 */
export async function mockGetUserMedia(page: Page, fixturePath = "/tests/fixtures/sample-1s.webm") {
  await page.addInitScript(path => {
    const original = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices)
    if (original === undefined) {
      throw new Error("mockGetUserMedia: navigator.mediaDevices.getUserMedia not present")
    }
    const fakeGUM = async (_: MediaStreamConstraints) => {
      const video = document.createElement("video")
      video.src = path
      video.loop = true
      video.muted = false
      video.crossOrigin = "anonymous"
      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve()
        video.onerror = () => reject(new Error("mockGUM: video load failed"))
      })
      await video.play()
      type WithCapture = HTMLVideoElement & { captureStream(): MediaStream }
      return (video as WithCapture).captureStream()
    }
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      writable: true,
      value: fakeGUM,
    })
  }, fixturePath)
}

/** Click a frame by its layout path. Frames are now rendered to a WebGL
 *  canvas — there are no per-frame DOM elements — so we synthesize a
 *  mouse click at the leaf's screen-space center, computed from the
 *  `window.__layoutFrames` test hook. */
export async function clickFrame(page: Page, path: number[], options?: { force?: boolean }) {
  void options
  const key = path.join(".")
  const center = await page.evaluate(k => {
    const fn = window.__layoutFrames
    if (!fn) {
      return null
    }
    const data = fn()
    const leaf = k === "" ? data.leaves[0] : data.leaves.find(l => l.path.join(".") === k)
    if (!leaf) {
      return null
    }
    const screenX = leaf.rect.x * data.viewport.scale + data.viewport.x
    const screenY = leaf.rect.y * data.viewport.scale + data.viewport.y
    const screenW = leaf.rect.width * data.viewport.scale
    const screenH = leaf.rect.height * data.viewport.scale
    return {
      x: data.canvas.left + screenX + screenW / 2,
      y: data.canvas.top + screenY + screenH / 2,
    }
  }, key)
  if (!center) {
    throw new Error(`clickFrame: no leaf at path ${key}`)
  }
  // `force` retained for API parity but not needed — canvas clicks land
  // on a fixed-size DOM element.
  await page.mouse.click(center.x, center.y)
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
  // Notches are no longer scoped under a per-frame [data-path] element —
  // they live in a flat overlay div carrying [data-selected-path]. The
  // overlay is suppressed during animations, so wait for it to appear
  // with the expected selected path before clicking. Only one path is
  // selected at a time, so direction alone identifies the handle.
  await page
    .locator(`[data-selected-path="${key.replace(/"/g, '\\"')}"]`)
    .waitFor({ state: "attached", timeout: 5000 })
  const notch = page.locator(`[data-direction="${dir}"]`).last()
  // The notch wrapper itself stopPropagation()s onClick — its inner
  // .notchBackdrop > .edge / .center / .root carry the handlers. Use
  // dispatchEvent in `force` mode (bypasses scroll-into-view, useful when
  // the rotated CSS-transformed handle's bounding box leaks past the
  // browser viewport).
  if (options?.force) {
    await notch.locator("> div > div").first().dispatchEvent("click")
    return
  }
  // Dispatch a click event programmatically. Playwright's locator.click()
  // refuses the rotated notches with "element is outside of the viewport"
  // because their post-transform bounding boxes leak past the window
  // edge. dispatchEvent bypasses that gate.
  await notch.locator("> div > div").first().dispatchEvent("click")
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
 *  screen-space coords (canvas-local with viewport scale + pan applied). */
export async function frameRect(page: Page, path: number[]) {
  const key = path.join(".")
  return page.evaluate(k => {
    const fn = window.__layoutFrames
    if (!fn) {
      return null
    }
    const data = fn()
    const leaf = k === "" ? data.leaves[0] : data.leaves.find(l => l.path.join(".") === k)
    if (!leaf) {
      return null
    }
    return {
      x: leaf.rect.x * data.viewport.scale + data.viewport.x,
      y: leaf.rect.y * data.viewport.scale + data.viewport.y,
      w: leaf.rect.width * data.viewport.scale,
      h: leaf.rect.height * data.viewport.scale,
    }
  }, key)
}

/** Read the canvas viewport transform via the test hook. Returns the
 *  current {x, y, scale} plus canvas dimensions. */
export async function readViewport(page: Page) {
  return page.evaluate(() => {
    const fn = window.__layoutFrames
    if (!fn) {
      return null
    }
    const data = fn()
    return {
      x: data.viewport.x,
      y: data.viewport.y,
      scale: data.viewport.scale,
      width: data.canvas.width,
      height: data.canvas.height,
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
  | { type: "record-start" }
  | { type: "record-stop" }
  | { type: "play" }
  | { type: "stop" }
  | { type: "delete-selection" }

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
      case "record-start":
        await clickAction(page, "record-start")
        break
      case "record-stop":
        await clickAction(page, "record-stop")
        break
      case "play":
        await clickAction(page, "play")
        break
      case "stop":
        await clickAction(page, "stop")
        break
      case "delete-selection":
        await page.evaluate(() => window.__appContext?.deleteSelection())
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
    const fn = (window as unknown as { __layoutFrames?: () => unknown }).__layoutFrames
    if (!fn) {
      return null
    }
    const data = fn() as {
      selectedRect: { x: number; y: number; width: number; height: number } | null
      viewport: { x: number; y: number; scale: number }
      canvas: { width: number; height: number }
    }
    if (!data.selectedRect) {
      return null
    }
    const screenX = data.selectedRect.x * data.viewport.scale + data.viewport.x
    const screenY = data.selectedRect.y * data.viewport.scale + data.viewport.y
    return {
      frame: {
        x: screenX,
        y: screenY,
        w: data.selectedRect.width * data.viewport.scale,
        h: data.selectedRect.height * data.viewport.scale,
      },
      canvas: { w: data.canvas.width, h: data.canvas.height },
    }
  })

  if (!result) {
    throw new Error(
      "expectFrameRespectsMargin: no selected frame found (window.__layoutFrames returned no selectedRect)",
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
