import { expect, type Locator, type Page } from '@playwright/test'
import { Schema } from 'effect'

import { MeasureResult, type Snapshot } from '../src/headless/index.ts'
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

/** Acquire a browser-owned scoped resource; only the bridge token crosses realms. */
export const acquireMeasurement = (host: Locator): Promise<string> =>
  host.evaluate((element) => {
    const boundary: StoryBridgeHost = element as StoryBridgeHost
    if (boundary.metersTestBridge === undefined)
      throw new Error('Scoped meters test bridge is not registered')
    return boundary.metersTestBridge.acquireMeasurement()
  })

/** Decode the wire result after real browser-frame settlement and scope release. */
export const finishMeasurement = async (options: {
  readonly host: Locator
  readonly token: string
  readonly settleFrames: number
}): Promise<MeasureResult> => {
  // oxlint-disable-next-line overeng/named-args -- Playwright supplies the element and serialized argument.
  const wire = await options.host.evaluate(
    (element, args) => {
      const boundary: StoryBridgeHost = element as StoryBridgeHost
      if (boundary.metersTestBridge === undefined)
        throw new Error('Scoped meters test bridge is not registered')
      return boundary.metersTestBridge.finishMeasurement(args)
    },
    { token: options.token, settleFrames: options.settleFrames },
  )
  return Schema.decodeUnknownSync(MeasureResult)(wire)
}

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
