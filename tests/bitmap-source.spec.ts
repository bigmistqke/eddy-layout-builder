import { expect, mockGetUserMedia, test } from "./helpers"

test("bitmap-source: clip source latestFrame returns null before seek, populates after", async ({ page }) => {
  await mockGetUserMedia(page)
  await page.goto("/")

  // Record a short clip so the demuxer has real data to feed.
  await page.locator('[data-action="record-start"]').click()
  await page.waitForFunction(() => window.__appContext?.previewTargetCellId() !== null, { timeout: 5000 })
  await page.waitForTimeout(700)
  await page.locator('[data-action="record-stop"]').click()
  await page.waitForFunction(
    () => Object.keys(window.__appContext?.clips.clips ?? {}).length === 1,
    { timeout: 20_000 },
  )

  // Drive the BitmapSource contract directly via the clip.
  // Phase 2: BitmapSource is backed by a Web Worker that reads frames
  // from OPFS, so seek() is async — wait for the worker to publish a
  // frame before reading after-state.
  const before = await page.evaluate(() => {
    const ctx = window.__appContext
    if (!ctx) {
      return { error: "no context" }
    }
    const ids = Object.keys(ctx.clips.clips)
    const clip = ctx.clips.clips[ids[0]]
    // Reset to defeat any seek the render loop performed after autoplay
    // kicked in post-record-stop. Read latest synchronously in the same
    // tick — the worker round-trip can't have completed yet.
    clip.video.reset()
    const beforeFrame = clip.video.latestFrame()
    clip.video.seek(0)
    return { cellId: ids[0], beforeIsNull: beforeFrame === null }
  })

  await page.waitForFunction(
    () => {
      const ctx = window.__appContext
      if (!ctx) {
        return false
      }
      const ids = Object.keys(ctx.clips.clips)
      const clip = ctx.clips.clips[ids[0]]
      return clip.video.latestFrame() !== null
    },
    { timeout: 5000 },
  )

  const after = await page.evaluate(() => {
    const ctx = window.__appContext
    if (!ctx) {
      return { error: "no context" }
    }
    const ids = Object.keys(ctx.clips.clips)
    const clip = ctx.clips.clips[ids[0]]
    const frame = clip.video.latestFrame()
    return {
      afterNotNull: frame !== null,
      afterIsRgbaShape:
        frame !== null &&
        typeof frame.width === "number" &&
        typeof frame.height === "number" &&
        frame.bytes instanceof Uint8Array &&
        frame.bytes.byteLength === frame.width * frame.height * 4,
    }
  })

  const result = { ...before, ...after }

  expect(result.beforeIsNull).toBe(true)
  expect(result.afterNotNull).toBe(true)
  expect(result.afterIsRgbaShape).toBe(true)
})
