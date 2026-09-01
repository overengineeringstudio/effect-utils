/**
 * Browser-side project annotations that turn every story into a gate case.
 *
 * Applied by `./setup.ts`, which only ever runs under Vitest — the Storybook UI
 * never loads this module, so the `vitest/browser` import stays out of the
 * preview bundle.
 *
 * @module
 */

import { expect } from 'vitest'
import { page } from 'vitest/browser'

import { excludedStoryMarker } from './constants.ts'

/** Minimal shape of the story context the gate reads. */
interface GateStoryContext {
  readonly id: string
  readonly canvasElement: HTMLElement
  readonly parameters?: { readonly storyGate?: { readonly unstable?: boolean } }
}

/**
 * The two per-story gate behaviours whose ecosystem defaults fail silently.
 *
 * `parameters.a11y.test` defaults to `'todo'`, which downgrades every violation
 * to a warning — measured: an icon-only button with no accessible name passed.
 * `'error'` is the only value that fails the run.
 *
 * The screenshot assertion is ours because the Storybook Vitest addon has no
 * visual capability at all; its "visual tests" panel is a cloud service. The
 * story id is used as the screenshot name so the baseline filename set is a
 * faithful projection of the story index — which is what makes an added or
 * removed story detectable without a second source of truth.
 */
export const storyGateAnnotations = {
  parameters: { a11y: { test: 'error' } },
  afterEach: async (context: GateStoryContext): Promise<void> => {
    // Escape hatch for surfaces no freeze can settle — a live WebGL canvas
    // never produces two identical consecutive frames. Without an explicit
    // opt-out those stories fail at the baseline, land in `preExisting`, and
    // silently suppress their own compare-side failures: the defect this gate
    // was just fixed for, reintroduced through a different door. Opting out
    // takes the story out of the visual comparison entirely and says so;
    // render, play and accessibility still run.
    if (context.parameters?.storyGate?.unstable === true) {
      // eslint-disable-next-line no-console -- the only channel from the browser back to the runner.
      console.info(`${excludedStoryMarker}${context.id}`)
      return
    }

    await expect(page.elementLocator(context.canvasElement)).toMatchScreenshot(context.id)
  },
}
