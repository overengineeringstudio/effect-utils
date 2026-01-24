/**
 * Effect wrappers for Playwright Page methods.
 *
 * @module
 */

import type { Page } from '@playwright/test'
import { Effect, Fiber } from 'effect'

import { type PwOpError, tryPw } from './op.ts'
import { PwPage } from './tags.ts'

type WaitUntil = NonNullable<Parameters<Page['goto']>[1]>['waitUntil']
type LoadState = Parameters<Page['waitForLoadState']>[0]
type URLMatch = Parameters<Page['waitForURL']>[0]

/**
 * Navigates to a URL.
 *
 * Prefer this wrapper so navigation is consistently traced and errors are normalized.
 */
export const goto: (args: {
  /** Target URL to navigate to. */
  url: string
  /** Playwright navigation wait strategy (defaults to Playwright behavior). */
  waitUntil?: WaitUntil
}) => Effect.Effect<void, PwOpError, PwPage> = Effect.fn('pw.page.goto')(({ url, waitUntil }) =>
  Effect.gen(function* () {
    const page = yield* PwPage
    yield* tryPw({
      op: 'pw.page.goto',
      effect: () =>
        page.goto(url, waitUntil !== undefined ? { waitUntil } : {}).then(() => undefined),
    }).pipe(
      Effect.tap(() =>
        Effect.annotateCurrentSpan({
          'pw.url': url,
          'pw.waitUntil': waitUntil ?? '',
        }),
      ),
    )
  }),
)

/**
 * Returns the current page URL.
 *
 * This can throw in Playwright when the page is already closed, so prefer the wrapper.
 */
export const url: Effect.Effect<string, PwOpError, PwPage> = Effect.gen(function* () {
  const page = yield* PwPage
  return yield* tryPw({
    op: 'pw.page.url',
    effect: () => Promise.resolve(page.url()),
  })
}).pipe(Effect.withSpan('pw.page.url'))

/** Waits for a specific load state. */
export const waitForLoadState: (args: {
  /** Load state to wait for (e.g. `domcontentloaded`, `networkidle`). */
  state: LoadState
}) => Effect.Effect<void, PwOpError, PwPage> = Effect.fn('pw.page.waitForLoadState')(({ state }) =>
  Effect.gen(function* () {
    const page = yield* PwPage
    yield* tryPw({
      op: 'pw.page.waitForLoadState',
      effect: () => page.waitForLoadState(state),
    }).pipe(Effect.tap(() => Effect.annotateCurrentSpan({ 'pw.loadState': String(state) })))
  }),
)

/**
 * Waits for the page URL to change.
 *
 * Prefer using `withURLChange` when waiting for a URL change triggered by an action, so the wait
 * starts before the action runs.
 *
 * If a navigation keeps the same URL (reloads), prefer `waitForLoadState` or an explicit
 * `waitForURL` target.
 */
export const waitForURLChange: (args: {
  /** Playwright navigation wait strategy (defaults to Playwright behavior). */
  waitUntil?: WaitUntil
}) => Effect.Effect<void, PwOpError, PwPage> = Effect.fn('pw.page.waitForURLChange')(
  ({ waitUntil }) =>
    Effect.gen(function* () {
      const page = yield* PwPage
      const currentUrl = yield* tryPw({
        op: 'pw.page.url',
        effect: () => Promise.resolve(page.url()),
      })
      yield* tryPw({
        op: 'pw.page.waitForURLChange',
        effect: () =>
          page
            .waitForURL(
              (url) => url.toString() !== currentUrl,
              waitUntil !== undefined ? { waitUntil } : {},
            )
            .then(() => undefined),
      }).pipe(
        Effect.tap(() =>
          Effect.annotateCurrentSpan({
            'pw.waitUntil': waitUntil ?? '',
            'pw.url': currentUrl,
          }),
        ),
      )
    }),
)

/**
 * Waits for the page to match a URL.
 *
 * Prefer this when you know the target URL pattern; otherwise use `waitForURLChange`.
 */
export const waitForURL: (args: {
  /** URL pattern to wait for (string / RegExp / predicate). */
  url: URLMatch
  /** Optional wait strategy for the load state during the URL change. */
  waitUntil?: WaitUntil
  /** Optional timeout in milliseconds. */
  timeoutMs?: number
}) => Effect.Effect<void, PwOpError, PwPage> = Effect.fn('pw.page.waitForURL')(
  ({ url, waitUntil, timeoutMs }) =>
    Effect.gen(function* () {
      const page = yield* PwPage
      yield* tryPw({
        op: 'pw.page.waitForURL',
        effect: () =>
          page
            .waitForURL(url, {
              ...(waitUntil !== undefined ? { waitUntil } : {}),
              ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
            })
            .then(() => undefined),
      }).pipe(
        Effect.tap(() =>
          Effect.annotateCurrentSpan({
            'pw.waitUntil': waitUntil ?? '',
            'pw.timeout.ms': timeoutMs ?? 0,
            'pw.urlMatch':
              typeof url === 'string' ? url : url instanceof RegExp ? url.source : 'function',
          }),
        ),
      )
    }),
)

/**
 * Runs `action` and waits for the page URL to change.
 *
 * Prefer this over manually racing / `Effect.all` because it reliably starts the
 * URL wait *before* running the action.
 */
export const withURLChange: <TResult, TError, TContext>(args: {
  /** Effect that triggers the URL change (e.g. clicking a submit button). */
  action: Effect.Effect<TResult, TError, TContext>
  /** Optional wait strategy for the URL change. */
  waitUntil?: WaitUntil
}) => Effect.Effect<TResult, TError | PwOpError, PwPage | TContext> = Effect.fn(
  'pw.page.withURLChange',
)(({ action, waitUntil }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const navFiber = yield* waitForURLChange({ waitUntil }).pipe(Effect.forkScoped)
      const result = yield* action
      yield* Fiber.join(navFiber)
      return result
    }),
  ),
)

/** Delays the test for a short period. Prefer `Pw.Wait.until` for polling. */
export const waitForTimeout: (args: {
  /** Delay duration in milliseconds. */
  ms: number
}) => Effect.Effect<void, PwOpError, PwPage> = Effect.fn('pw.page.waitForTimeout')(({ ms }) =>
  Effect.gen(function* () {
    const page = yield* PwPage
    yield* tryPw({
      op: 'pw.page.waitForTimeout',
      effect: () => page.waitForTimeout(ms),
    }).pipe(Effect.tap(() => Effect.annotateCurrentSpan({ 'pw.timeout.ms': ms })))
  }),
)

/**
 * Sleeps for a random duration between `msMin` and `msMax` (inclusive).
 *
 * Useful to avoid unrealistically fast interactions in live auth flows.
 */
export const jitter: (args?: {
  /** Minimum delay in milliseconds (inclusive). */
  msMin?: number
  /** Maximum delay in milliseconds (inclusive). */
  msMax?: number
}) => Effect.Effect<void, PwOpError, PwPage> = Effect.fn('pw.page.jitter')((args) => {
  const msMin = args?.msMin ?? 120
  const msMax = args?.msMax ?? 420
  return waitForTimeout({
    ms: Math.floor(Math.random() * (msMax - msMin + 1)) + msMin,
  }).pipe(
    Effect.tap(() =>
      Effect.annotateCurrentSpan({
        'pw.jitter.msMin': msMin,
        'pw.jitter.msMax': msMax,
      }),
    ),
  )
})

/** Returns whether the page is already closed. */
export const isClosed: Effect.Effect<boolean, never, PwPage> = Effect.gen(function* () {
  const page = yield* PwPage
  return page.isClosed()
}).pipe(Effect.withSpan('pw.page.isClosed'))

/** Sets the page viewport size. */
export const setViewportSize: (args: {
  /** Viewport width in pixels. */
  width: number
  /** Viewport height in pixels. */
  height: number
}) => Effect.Effect<void, PwOpError, PwPage> = Effect.fn('pw.page.setViewportSize')(
  ({ width, height }) =>
    Effect.gen(function* () {
      const page = yield* PwPage
      yield* tryPw({
        op: 'pw.page.setViewportSize',
        effect: () => page.setViewportSize({ width, height }),
      }).pipe(
        Effect.tap(() =>
          Effect.annotateCurrentSpan({
            'pw.viewport.width': width,
            'pw.viewport.height': height,
          }),
        ),
      )
    }),
)

/**
 * Evaluates a function in the page context (no arguments).
 *
 * @example
 * ```typescript
 * const title = yield* Pw.Page.evaluate(() => document.title)
 * ```
 */
export const evaluate: <R>(
  /** Function to evaluate in page context. */
  fn: () => R | Promise<R>,
) => Effect.Effect<R, PwOpError, PwPage> = Effect.fn('pw.page.evaluate')((fn) =>
  Effect.gen(function* () {
    const page = yield* PwPage
    return yield* tryPw({
      op: 'pw.page.evaluate',
      effect: () => page.evaluate(fn),
    })
  }),
)

/**
 * Evaluates a function in the page context with an argument.
 *
 * @example
 * ```typescript
 * const text = yield* Pw.Page.evaluateWith({ arg: '#my-id', fn: (sel) => document.querySelector(sel)?.textContent })
 * ```
 */
export const evaluateWith = Effect.fn('pw.page.evaluate')(function* <R, TArg>(opts: {
  /** Argument to pass to the function. */
  arg: TArg
  /** Function to evaluate in page context. */
  fn: (arg: TArg) => R | Promise<R>
}) {
  const page = yield* PwPage
  return yield* tryPw<R>({
    op: 'pw.page.evaluate',
    effect: () => page.evaluate(opts.fn as Parameters<Page['evaluate']>[0], opts.arg) as Promise<R>,
  })
})

/** Returns the raw Playwright Page for direct access. Use sparingly. */
export const raw: Effect.Effect<Page, never, PwPage> = PwPage

/** Screenshot options matching Playwright's Page.screenshot() options. */
type ScreenshotOptions = Parameters<Page['screenshot']>[0]

/**
 * Take a screenshot of the page.
 *
 * @example
 * ```typescript
 * yield* Pw.Page.screenshot({ path: 'tmp/screenshot.png' })
 * yield* Pw.Page.screenshot({ path: 'tmp/full.png', fullPage: true })
 * ```
 */
export const screenshot: (options?: ScreenshotOptions) => Effect.Effect<Buffer, PwOpError, PwPage> =
  Effect.fn('pw.page.screenshot')((options) =>
    Effect.gen(function* () {
      const page = yield* PwPage
      return yield* tryPw({
        op: 'pw.page.screenshot',
        effect: () => page.screenshot(options),
      }).pipe(
        Effect.tap(() =>
          Effect.annotateCurrentSpan({
            'pw.screenshot.path': options?.path ?? '',
            'pw.screenshot.fullPage': options?.fullPage ?? false,
          }),
        ),
      )
    }),
  )
