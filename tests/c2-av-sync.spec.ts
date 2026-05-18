import { expect, mockGetUserMedia, test } from "./helpers"

test("c2 A/V sync: drift in each WebM ≤ 200ms", async ({ page }) => {
  await mockGetUserMedia(page)
  await page.goto("/")

  await page.locator('[data-action="record-start"]').click()
  await page.waitForFunction(() => window.__appContext?.previewTargetCellId() !== null, {
    timeout: 5000,
  })
  // Longer record so the drift measurement has meaningful resolution.
  await page.waitForTimeout(2000)
  await page.locator('[data-action="record-stop"]').click()
  await page.waitForFunction(
    () => Object.keys(window.__appContext?.clips.clips ?? {}).length === 1,
    { timeout: 30_000 },
  )

  // Use mediabunny in-page to demux each mip and measure the drift
  // (lastVideoEnd vs lastAudioEnd). Mirrors exp 30c's measurement.
  const drifts = await page.evaluate(async () => {
    const cellId = Object.keys(window.__appContext?.clips.clips ?? {})[0]
    const projectId = window.__appContext?.projects.activeId()
    if (!cellId || !projectId) {
      return null
    }
    const root = await navigator.storage.getDirectory()
    const projects = await root.getDirectoryHandle("projects")
    const project = await projects.getDirectoryHandle(projectId)
    const clips = await project.getDirectoryHandle("clips")
    const mb = (window as unknown as { __mediabunny: typeof import("mediabunny") }).__mediabunny
    const { Input, BlobSource, ALL_FORMATS, EncodedPacketSink } = mb
    async function driftFor(name: string): Promise<number | null> {
      try {
        const handle = await clips.getFileHandle(name)
        const file = await handle.getFile()
        const input = new Input({
          formats: ALL_FORMATS,
          source: new BlobSource(file),
        })
        const v = (await input.getVideoTracks())[0]
        const a = (await input.getAudioTracks())[0]
        if (!v || !a) {
          return null
        }
        let lastV = 0
        for await (const p of new EncodedPacketSink(v).packets()) {
          lastV = (p.timestamp ?? 0) + (p.duration ?? 0)
        }
        let lastA = 0
        for await (const p of new EncodedPacketSink(a).packets()) {
          lastA = (p.timestamp ?? 0) + (p.duration ?? 0)
        }
        return Math.abs(lastV - lastA) * 1000
      } catch {
        return null
      }
    }
    return {
      hi: await driftFor(`${cellId}.720p.webm`),
      lo: await driftFor(`${cellId}.270p.webm`),
    }
  })

  expect(drifts).not.toBeNull()
  expect(drifts!.hi).not.toBeNull()
  expect(drifts!.lo).not.toBeNull()
  expect(drifts!.hi).toBeLessThanOrEqual(200)
  expect(drifts!.lo).toBeLessThanOrEqual(200)
})
