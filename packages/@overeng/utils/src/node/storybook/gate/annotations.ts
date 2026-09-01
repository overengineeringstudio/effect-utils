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

import {
  excludedStoryMarker,
  settledStoryMarker,
  storySettleConfig,
  type StorySettleRecord,
  unsettledStoryMarker,
} from './constants.ts'

/** Minimal shape of the story context the gate reads. */
interface GateStoryContext {
  readonly id: string
  readonly canvasElement: HTMLElement
  /** Component title, e.g. `Components/Select`. */
  readonly title?: string
  /** Story name, e.g. `With Error`. */
  readonly name?: string
  readonly parameters?: { readonly storyGate?: { readonly unstable?: boolean } }
}

/**
 * The only channel from the browser back to the runner.
 *
 * `console.info` rather than a return value because the story's outcome has to
 * reach a Node process that only sees this run's stdout and its JSON report,
 * and the JSON report has no field for "why this story was not compared".
 */
const emit = (line: string): void => {
  // eslint-disable-next-line no-console -- the only channel from the browser back to the runner.
  console.info(line)
}

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

/**
 * Structural signature of the subtree that is about to be captured.
 *
 * Element count catches additions and removals; markup length catches attribute
 * and text churn that leaves the count constant.
 *
 * Deliberately NOT computed-style or pixel based, and this is the load-bearing
 * property rather than an implementation detail. This predicate decides *when*
 * to read, so if it depended on *what* is read, the readiness check and the
 * measurement could agree with each other while both were wrong. Reusing the
 * screenshot or a style reader here is the trap.
 *
 * Rooted at `canvasElement` because that is exactly the element
 * `toMatchScreenshot` captures. Settling over a wider root would wait on
 * content that is never compared; a narrower one would read a subtree while its
 * container still moved. Content portalled out of the canvas is outside both the
 * predicate and the capture, so the two stay in agreement by construction.
 */
const shapeOf = (root: HTMLElement): string =>
  `${root.querySelectorAll('*').length}:${root.innerHTML.length}`

/**
 * Keep a shape history readable without lying about its length.
 *
 * A story that never settles can churn for the whole bound, and a hundred
 * entries on one console line is a channel nobody reads. Both ends are kept
 * because they answer different questions — the first shapes say what the story
 * started as, the last say what it was still doing when the bound expired — and
 * the elision states its own size rather than trailing off.
 */
const summariseShapes = (shapes: readonly string[]): readonly string[] => {
  const keep = 6
  if (shapes.length <= keep * 2) return shapes
  return [
    ...shapes.slice(0, keep),
    `… ${shapes.length - keep * 2} more transitions elided …`,
    ...shapes.slice(-keep),
  ]
}

/**
 * Wait for webfonts, bounded.
 *
 * Not redundant with the shape predicate: a font swap resizes exactly the
 * content-sized elements while leaving element count and markup length
 * untouched, so a pure reflow is invisible to the signature. This is a cheap
 * belt for packages that ship a webfont, not a claim that fonts are the cause
 * anywhere in particular.
 */
const fontsReady = async (): Promise<boolean> => {
  const fonts: FontFaceSet | undefined = document.fonts
  if (fonts === undefined) return true
  return await Promise.race([
    fonts.ready.then(() => true),
    sleep(storySettleConfig.fontsBoundMs).then(() => false),
  ])
}

/**
 * Poll the captured subtree until its shape repeats `quietPolls` times running,
 * or the bound expires.
 *
 * Returns the outcome instead of throwing, because the caller has to RECORD
 * whether the story settled. That is the whole point of the mechanism and it
 * matters more than the waiting: a story that never settles is still named,
 * counted and attributable, which makes it an exclusion rather than a
 * disappearance.
 */
const settle = async (
  root: HTMLElement,
): Promise<{ readonly settled: boolean; readonly shapes: readonly string[] }> => {
  const { quietPolls, pollIntervalMs, boundMs } = storySettleConfig
  const deadline = Date.now() + boundMs
  const shapes: string[] = []
  let previous: string | undefined
  let repeats = 0

  for (;;) {
    const current = shapeOf(root)
    if (current === previous) {
      repeats += 1
      if (repeats >= quietPolls) return { settled: true, shapes }
    } else {
      repeats = 0
      previous = current
      shapes.push(current)
    }
    if (Date.now() >= deadline) return { settled: false, shapes }
    await sleep(pollIntervalMs)
  }
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
    const name =
      context.title === undefined || context.name === undefined
        ? context.id
        : `${context.title} > ${context.name}`

    // Escape hatch for surfaces no wait can settle — a live WebGL canvas never
    // reaches a quiet DOM and never will. Without an explicit opt-out those
    // stories fail at the baseline, land in `preExisting`, and silently suppress
    // their own compare-side failures: the defect this gate was just fixed for,
    // reintroduced through a different door. Opting out takes the story out of
    // the visual comparison entirely and says so; render, play and accessibility
    // still run.
    //
    // Checked BEFORE the settle signal, not after: a story declared unstable
    // should not spend the 20s bound proving what its author already stated.
    if (context.parameters?.storyGate?.unstable === true) {
      emit(`${excludedStoryMarker}${context.id}`)
      return
    }

    const started = Date.now()
    const fonts = await fontsReady()
    if (fonts === false) {
      const record: StorySettleRecord = {
        id: context.id,
        name,
        elapsedMs: Date.now() - started,
        shapes: [shapeOf(context.canvasElement)],
        reason: 'fonts-never-ready',
      }
      emit(`${unsettledStoryMarker}${JSON.stringify(record)}`)
      return
    }

    const outcome = await settle(context.canvasElement)
    const elapsedMs = Date.now() - started

    // Returning WITHOUT asserting is what keeps an unsettled story out of the
    // comparison cleanly. `toMatchScreenshot` is the only thing that resolves a
    // baseline path, and resolving a path is what enters a story in the run
    // manifest — so a story that never settles is absent from both sides rather
    // than half-present on one, and it cannot arrive in `preExisting` to
    // subtract a real failure later.
    if (outcome.settled === false) {
      const record: StorySettleRecord = {
        id: context.id,
        name,
        elapsedMs,
        shapes: summariseShapes(outcome.shapes),
        reason: 'shape-never-quiet',
      }
      emit(`${unsettledStoryMarker}${JSON.stringify(record)}`)
      return
    }

    const record: StorySettleRecord = {
      id: context.id,
      name,
      elapsedMs,
      shapes: summariseShapes(outcome.shapes),
    }
    emit(`${settledStoryMarker}${JSON.stringify(record)}`)

    await expect(page.elementLocator(context.canvasElement)).toMatchScreenshot(context.id)
  },
}
