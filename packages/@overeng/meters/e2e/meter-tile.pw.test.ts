import { expect, test, type Page } from '@playwright/test'

const story = (id: string) => `/iframe.html?id=meters-metertile--${id}&viewMode=story`

/** Frames sampled per story after warm-up. */
const sampledFrames = 300

/**
 * Time every requestAnimationFrame callback with user-timing measures. The session frame clock
 * is the page's only rAF client, so one callback is one frame's Source + Draw work.
 */
const instrumentFrames = (page: Page) =>
  page.addInitScript(() => {
    const native = window.requestAnimationFrame.bind(window)
    window.requestAnimationFrame = (callback) =>
      native((time) => {
        const start = performance.now()
        try {
          callback(time)
        } finally {
          performance.measure('meters.frame', { start, end: performance.now() })
        }
      })
  })

interface FrameCost {
  readonly frames: number
  readonly meanMs: number
  readonly p50Ms: number
  readonly p95Ms: number
}

const measureFrames = async (page: Page): Promise<FrameCost> => {
  // Warm up past mount, first layout and JIT, then sample a fresh window.
  await page.waitForFunction(() => performance.getEntriesByName('meters.frame').length >= 60)
  await page.evaluate(() => performance.clearMeasures('meters.frame'))
  await page.waitForFunction(
    (count) => performance.getEntriesByName('meters.frame').length >= count,
    sampledFrames,
    { timeout: 30_000 },
  )
  return page.evaluate((count) => {
    const durations = performance
      .getEntriesByName('meters.frame')
      .slice(0, count)
      .map((entry) => entry.duration)
      .toSorted((left, right) => left - right)
    const at = (quantile: number) => durations[Math.floor(quantile * (durations.length - 1))] ?? 0
    return {
      frames: durations.length,
      meanMs: durations.reduce((total, value) => total + value, 0) / durations.length,
      p50Ms: at(0.5),
      p95Ms: at(0.95),
    }
  }, sampledFrames)
}

test.describe('meter tiles', () => {
  test('six live tiles add under 0.5 ms of frame work over the same session without tiles', async ({
    page,
  }) => {
    await instrumentFrames(page)
    await page.goto(story('baseline'))
    await expect(page.getByRole('button', { name: 'Freeze meters' })).toBeVisible()
    const baseline = await measureFrames(page)
    await page.goto(story('live'))
    await expect(page.locator('canvas')).toHaveCount(6)
    const tiles = await measureFrames(page)
    const added = {
      meanMs: tiles.meanMs - baseline.meanMs,
      p50Ms: tiles.p50Ms - baseline.p50Ms,
      p95Ms: tiles.p95Ms - baseline.p95Ms,
    }
    const report = JSON.stringify({ baseline, tiles, added })
    test.info().annotations.push({ type: 'frame-cost', description: report })
    console.info(`meter tile frame cost ${report}`)
    expect(tiles.frames).toBe(sampledFrames)
    expect(added.meanMs).toBeLessThan(0.5)
    expect(added.p50Ms).toBeLessThan(0.5)
  })

  test('keyboard focus shows evidence, Enter and Space refresh it, freeze toggles', async ({
    page,
  }) => {
    await page.goto(story('live'))
    const tile = page.getByRole('button', { name: 'fps', exact: true })
    await expect(tile).toHaveAttribute('title', 'Frames')
    await page.getByRole('button', { name: 'Freeze meters' }).focus()
    await page.keyboard.press('Tab')
    await expect(tile).toBeFocused()
    const card = page.getByRole('tooltip')
    await expect(card).toContainText('Snapshot taken on focus')
    await expect(card).toContainText('before evaluation')
    await page.keyboard.press('Enter')
    await expect(card).toContainText('Snapshot taken on activation')
    await page.keyboard.press('r')
    await expect(card).toContainText('Snapshot refreshed')
    await page.keyboard.press('Space')
    await expect(card).toContainText('Snapshot taken on activation')
    await expect(tile).toHaveAccessibleName('fps')
    await page.keyboard.press('Escape')
    await expect(card).toHaveCount(0)
    await page.keyboard.press('Shift+Tab')
    const freeze = page.getByRole('button', { name: 'Freeze meters' })
    await expect(freeze).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(freeze).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('Tab')
    await expect(card).toContainText('(frozen)')
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Space')
    await expect(freeze).toHaveAttribute('aria-pressed', 'false')
  })
})
