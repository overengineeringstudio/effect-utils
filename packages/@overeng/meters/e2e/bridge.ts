import { expect, type Locator, type Page } from '@playwright/test'

import type { MeasureHandle, MeasureResult, Snapshot } from '../src/headless/index.ts'
import type { StoryBridgeHost } from '../src/stories/fixtures.tsx'

/** Select the explicitly registered DOM boundary; no browser global handle is published. */
export const bridgeHost = async (page: Page): Promise<Locator> => {
  const host = page.getByTestId('meters-test-host')
  await expect(host).toHaveAttribute('data-ready', 'true')
  return host
}

/** Read real session evidence through the host-selected automation boundary. */
export const snapshot = (host: Locator): Promise<Snapshot> =>
  host.evaluate((element) => {
    const boundary: StoryBridgeHost = element as StoryBridgeHost
    if (boundary.metersTestBridge === undefined)
      throw new Error('Scoped meters test bridge is not registered')
    return boundary.metersTestBridge.snapshot()
  })

/** Open a serializable bracket from the live session, not a synthetic test engine. */
export const beginMeasure = (host: Locator): Promise<MeasureHandle> =>
  host.evaluate((element) => {
    const boundary: StoryBridgeHost = element as StoryBridgeHost
    if (boundary.metersTestBridge === undefined)
      throw new Error('Scoped meters test bridge is not registered')
    return boundary.metersTestBridge.beginMeasure()
  })

/** Settle on actual browser frames and preserve tagged eligibility in the result. */
export const endMeasure = (options: {
  readonly host: Locator
  readonly handle: MeasureHandle
  readonly settleFrames: number
}): Promise<MeasureResult> =>
  // oxlint-disable-next-line overeng/named-args -- Playwright evaluate supplies the selected element and serialized argument.
  options.host.evaluate(
    (element, args) => {
      const boundary: StoryBridgeHost = element as StoryBridgeHost
      if (boundary.metersTestBridge === undefined)
        throw new Error('Scoped meters test bridge is not registered')
      return boundary.metersTestBridge.endMeasure(args)
    },
    { handle: options.handle, settleFrames: options.settleFrames },
  )

/** Read calibration evidence rather than guessing a wall-clock warm-up delay. */
export const waitForCalibration = async (host: Locator): Promise<void> => {
  await expect
    .poll(
      async () => {
        const evidence = await snapshot(host)
        return evidence.frames._tag === 'Value'
          ? evidence.frames.value.calibration._tag
          : evidence.frames._tag
      },
      { timeout: 15_000 },
    )
    .toBe('Calibrated')
}
