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

/** Minimal shape of the story context the gate reads. */
interface GateStoryContext {
  readonly id: string
  readonly canvasElement: HTMLElement
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
    await expect(page.elementLocator(context.canvasElement)).toMatchScreenshot(context.id)
  },
}
