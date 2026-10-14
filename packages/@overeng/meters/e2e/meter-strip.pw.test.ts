import { expect, test } from '@playwright/test'

import { bridgeHost, snapshot } from './bridge.ts'

const liveStory = '/iframe.html?id=meters-meterstrip--live&viewMode=story&testBridge=meters-e2e'

test.describe('MeterStrip', () => {
  test('draws real pixels and exposes every configured source', async ({ page }) => {
    await page.goto(liveStory)
    const host = await bridgeHost(page)
    const canvas = page.locator('canvas')
    await expect(canvas).toBeVisible()
    const box = await canvas.boundingBox()
    expect(box?.width).toBeGreaterThan(0)
    expect(box?.height).toBeGreaterThan(0)
    await expect
      .poll(async () => {
        const evidence = await snapshot(host)
        return evidence.frames._tag === 'Value' ? evidence.frames.value.framesCaptured : 0
      })
      .toBeGreaterThan(2)
    const painted = await canvas.evaluate((element) => {
      if (element instanceof HTMLCanvasElement === false) throw new Error('Expected strip canvas')
      const context = element.getContext('2d')
      if (context === null) throw new Error('2D canvas is unavailable')
      const pixels = context.getImageData(0, 0, element.width, element.height).data
      // oxlint-disable-next-line overeng/named-args -- Native TypedArray.some callback signature.
      return pixels.some((value, index) => index % 4 === 3 && value > 0)
    })
    expect(painted).toBe(true)
    for (const label of [
      'Frames',
      'Long frames',
      'JS heap (approximate)',
      'Clicks',
      'React commits',
    ]) {
      await expect(page.getByLabel(label, { exact: true })).toBeAttached()
    }
  })

  test('freeze holds a bounded renderer view while counters and frames keep collecting', async ({
    page,
  }) => {
    await page.goto(liveStory)
    const host = await bridgeHost(page)
    const clicks = page.getByLabel('Clicks', { exact: true })
    await expect(clicks).not.toHaveText('n/a (NoSamples)')
    await page.getByRole('button', { name: 'Freeze meters' }).click()
    await expect(page.getByRole('button', { name: 'Resume meters' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    const frozenText = await clicks.textContent()
    const frozenCanvas = await page.locator('canvas').screenshot()
    const before = await snapshot(host)
    await page.getByRole('button', { name: /^Increment counter/ }).click()
    await expect
      .poll(async () => (await snapshot(host)).counters['story.clicks'])
      .toBe((before.counters['story.clicks'] ?? 0) + 1)
    await expect
      .poll(async () => {
        const evidence = await snapshot(host)
        return (
          evidence.retention.find((item) => item.id === 'story.frames')?.range.nextSequence ?? 0
        )
      })
      .toBeGreaterThan(
        (before.retention.find((item) => item.id === 'story.frames')?.range.nextSequence ?? 0) + 5,
      )
    await expect(clicks).toHaveText(frozenText ?? '')
    expect(Buffer.compare(frozenCanvas, await page.locator('canvas').screenshot())).toBe(0)
    await page.getByRole('button', { name: 'Resume meters' }).click()
    await expect(clicks).not.toHaveText(frozenText ?? '')
  })

  test('keyboard focus shows a tooltip and explicit activation logs the detail request', async ({
    page,
  }) => {
    await page.goto(liveStory)
    await bridgeHost(page)
    const frame = page.getByRole('button', { name: /^Frames:/ })
    await frame.focus()
    await expect(page.getByRole('tooltip')).toContainText('Frames:')
    await expect(page.getByLabel('Detail requests')).toHaveText('None')
    await frame.press('Enter')
    await expect(page.getByLabel('Detail requests')).toHaveText('story.frames')
    await frame.press('Escape')
    await expect(page.getByRole('tooltip')).toHaveCount(0)
  })

  test('injected missing heap API displays n/a instead of zero', async ({ page }) => {
    await page.goto('/iframe.html?id=meters-availability--unsupported-heap&viewMode=story')
    await expect(page.getByLabel('JS heap (approximate)', { exact: true })).toHaveText(
      'n/a (Unsupported)',
    )
  })

  test('automation bridge is absent without explicit host opt-in', async ({ page }) => {
    await page.goto('/iframe.html?id=meters-meterstrip--live&viewMode=story')
    await expect(page.locator('canvas')).toBeVisible()
    await expect(page.getByTestId('meters-test-host')).not.toHaveAttribute('data-ready', 'true')
    expect(
      await page
        .getByTestId('meters-test-host')
        .evaluate((element) => Object.hasOwn(element, 'metersTestBridge')),
    ).toBe(false)
  })
})
