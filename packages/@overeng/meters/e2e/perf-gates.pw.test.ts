import { expect, test } from '@playwright/test'

import { acquireMeasurement, bridgeHost, finishMeasurement, waitForCalibration } from './bridge.ts'

const interactiveStory =
  '/iframe.html?id=meters-perfgates--interactive&viewMode=story&testBridge=meters-e2e'

test.describe('headless performance gates', () => {
  test('measureWindow reports tagged eligibility for actual browser work', async ({ page }) => {
    await page.goto(interactiveStory)
    const host = await bridgeHost(page)
    await waitForCalibration(host)
    await page.getByRole('button', { name: 'Measure small work' }).click()
    const output = page.getByLabel('Measurement result')
    // A healthy, calibrated browser bracket must be Complete; ineligible evidence cannot pass a gate.
    await expect(output).toHaveAttribute('data-tag', 'Complete', { timeout: 10_000 })
    await expect(output).toContainText('eligible: true')
    await expect(output).toContainText('clicks: 1')
  })

  test('bridge options can be retried without serializing resource authority', async ({ page }) => {
    await page.goto(interactiveStory)
    const host = await bridgeHost(page)
    await waitForCalibration(host)
    const token = await acquireMeasurement(host)
    expect(typeof token).toBe('string')
    await expect(finishMeasurement({ host, token, settleFrames: -1 })).rejects.toThrow()
    await page.getByRole('button', { name: /^Increment counter/ }).click()
    const result = await finishMeasurement({ host, token, settleFrames: 3 })
    expect(result._tag).toBe('Complete')
    expect(result.data.counterDelta['story.clicks']).toBe(1)
    await expect(finishMeasurement({ host, token, settleFrames: 0 })).rejects.toThrow(
      'Bridge token is not active',
    )
    await expect(
      finishMeasurement({ host, token: 'foreign-token', settleFrames: 0 }),
    ).rejects.toThrow('Bridge token is not active')
  })

  test('blocking real browser work produces measured frame drops', async ({ page }) => {
    await page.goto(interactiveStory)
    const host = await bridgeHost(page)
    await waitForCalibration(host)
    const token = await acquireMeasurement(host)
    await page.getByRole('button', { name: 'Measure blocking work' }).click()
    await expect(page.getByLabel('Measurement result')).toHaveAttribute('data-tag', 'Complete', {
      timeout: 10_000,
    })
    const measurement = await finishMeasurement({ host, token, settleFrames: 5 })
    expect(measurement._tag).toBe('Complete')
    if (measurement._tag !== 'Complete')
      throw new Error(`Ineligible measurement: ${measurement.reasons.join(', ')}`)
    expect(measurement.eligible).toBe(true)
    expect(measurement.data.framesCaptured).toBeGreaterThan(0)
    expect(measurement.data.frameDrops).toBeGreaterThan(5)
    expect(measurement.data.counterDelta['story.clicks']).toBe(1)
  })

  test('leaf-held state commits only the instrumented counter subtree', async ({ page }) => {
    await page.goto(interactiveStory)
    const host = await bridgeHost(page)
    await waitForCalibration(host)
    const token = await acquireMeasurement(host)
    await page.getByRole('button', { name: /^Increment counter/ }).click()
    await expect(page.getByRole('button', { name: 'Increment counter (1)' })).toBeVisible()
    const measurement = await finishMeasurement({ host, token, settleFrames: 3 })
    expect(measurement._tag).toBe('Complete')
    if (measurement._tag !== 'Complete')
      throw new Error(`Ineligible measurement: ${measurement.reasons.join(', ')}`)
    expect(measurement.data.counterDelta['story.clicks']).toBe(1)
    expect(measurement.data.counterDelta['story.commits']).toBe(1)
    expect(measurement.data.counterDelta['story.sibling-commits']).toBeUndefined()
  })

  test('unconfigured measurements remain Incomplete and cannot satisfy a budget', async ({
    page,
  }) => {
    await page.goto(
      '/iframe.html?id=meters-perfgates--unconfigured&viewMode=story&testBridge=meters-e2e',
    )
    const host = await bridgeHost(page)
    const token = await acquireMeasurement(host)
    const measurement = await finishMeasurement({ host, token, settleFrames: 0 })
    expect(measurement._tag).toBe('Incomplete')
    expect(measurement.eligible).toBe(false)
    if (measurement._tag !== 'Incomplete')
      throw new Error('Unconfigured frame evidence must be ineligible')
    expect(measurement.reasons).toContain('NotConfigured')
    expect(measurement.data.frameDrops._tag).toBe('Unavailable')
    await expect(page.getByLabel('Measurement result')).toHaveAttribute('data-tag', 'Incomplete')
  })
})
