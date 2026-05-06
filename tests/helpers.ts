import type { Page } from "@playwright/test"

/** Click a frame by its layout path (e.g., [0, 1] → `[data-path="0.1"]`). */
export async function clickFrame(page: Page, path: number[]) {
  const key = path.join(".")
  await page.locator(`[data-path="${key}"]`).first().click()
}

/** Click a breadcrumb segment by its depth. Segments are buttons inside the
 *  top-left breadcrumb notch, ordered root → leaf left-to-right. */
export async function clickBreadcrumb(page: Page, depth: number) {
  // Buttons rendered in order via <For each={segments()}>; segment[i].depth
  // counts down from path.length to 0. Index by segment position, not depth,
  // since the test author can read the button index directly.
  const buttons = page.locator(".breadcrumbContent button")
  await buttons.nth(depth).click()
}

/** Click a directional handle on the currently selected frame. */
export async function clickHandle(page: Page, dir: "top" | "bottom" | "left" | "right") {
  await page.locator(`[data-path] .${dir}`).first().click()
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
