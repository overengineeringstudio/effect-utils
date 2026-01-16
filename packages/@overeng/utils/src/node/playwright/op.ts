/**
 * Effect-Playwright promise bridging primitives.
 *
 * @module
 */

import { Effect, Schema } from 'effect'

/**
 * Canonical error type for Playwright promise bridging.
 *
 * Any direct call into Playwright that can fail due to a closed page/context or timing issues should
 * be wrapped so tests receive structured errors and spans.
 */
export class PwOpError extends Schema.TaggedError<PwOpError>()('PwOpError', {
  /** Stable operation identifier (e.g. `pw.page.goto`, `pw.context.cookies`). */
  op: Schema.String,
  /** Underlying Playwright/Node defect. */
  cause: Schema.Defect,
}) {}

/**
 * Internal helper to wrap Playwright promises into Effects.
 *
 * Tests should prefer the higher-level helpers (e.g. `Pw.Page.goto`, `Pw.Locator.typeHuman`) instead
 * of calling this directly.
 */
export const tryPw = <TA>({
  op,
  effect,
}: {
  /** Stable operation identifier (used for error + span name). */
  op: string
  /** Promise factory; receives AbortSignal from Effect runtime. */
  effect: (signal: AbortSignal) => PromiseLike<TA>
}) =>
  Effect.tryPromise({
    try: effect,
    catch: (cause) => new PwOpError({ op, cause }),
  }).pipe(Effect.withSpan(op, { attributes: { 'pw.op': op } }))

/**
 * Generic fallback for wrapping any Playwright promise into an Effect.
 *
 * Use this for operations not covered by `Pw.Page.*` or `Pw.Locator.*` helpers.
 * Prefer the specific helpers when available for better span naming and attributes.
 *
 * @example
 * ```typescript
 * // For uncovered operations
 * yield* Pw.try({ op: 'set-viewport', effect: () => page.setViewportSize({ width: 1200, height: 800 }) })
 *
 * // Combine with Pw.Step for Playwright trace grouping
 * yield* Pw.try({ op: 'custom-op', effect: () => somePlaywrightCall() }).pipe(Pw.Step.step('Custom operation'))
 * ```
 */
export const try_: <A>(opts: {
  /** Short operation name for span (e.g. 'set-viewport', 'get-cookies'). */
  op: string
  /** Promise factory to wrap. */
  effect: () => PromiseLike<A>
}) => Effect.Effect<A, PwOpError> = ({ op, effect }) =>
  tryPw({ op: `pw.try.${op}`, effect }).pipe(
    Effect.tap(() => Effect.annotateCurrentSpan({ 'pw.try.op': op })),
  )

/**
 * Wraps a Playwright expect assertion into an Effect.
 *
 * @example
 * ```typescript
 * yield* Pw.expect({ assertion: 'sidebar-visible', expectPromise: expect(page.locator('aside')).toBeVisible() })
 * yield* Pw.expect({ assertion: 'title-matches', expectPromise: expect(page).toHaveTitle(/Dashboard/) })
 * ```
 */
export const expect_: <A>(opts: {
  /** Short assertion name for span (e.g. 'sidebar-visible', 'button-enabled'). */
  assertion: string
  /** Playwright expect promise (e.g. `expect(locator).toBeVisible()`). */
  expectPromise: PromiseLike<A>
}) => Effect.Effect<A, PwOpError> = ({ assertion, expectPromise }) =>
  tryPw({ op: `pw.expect.${assertion}`, effect: () => expectPromise }).pipe(
    Effect.tap(() => Effect.annotateCurrentSpan({ 'pw.expect.assertion': assertion })),
  )
