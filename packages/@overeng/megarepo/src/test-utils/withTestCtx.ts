/**
 * Test Context Wrapper
 *
 * Provides Effect-based test context with proper scoping, timeout management,
 * and NodeContext layer composition.
 */

import { NodeContext } from '@effect/platform-node'
import { Duration, Effect, Scope } from 'effect'

export interface TestCtxOptions {
  /** Timeout in milliseconds (default: 30_000) */
  readonly timeout?: number
}

/**
 * Create a test context wrapper with configurable timeout.
 *
 * Usage:
 * ```typescript
 * const withTestCtx = makeWithTestCtx()
 *
 * it('test name', () =>
 *   withTestCtx(
 *     Effect.gen(function* () {
 *       // test body
 *     })
 *   )
 * )
 * ```
 *
 * IMPORTANT: Do NOT use `(test) =>` parameter pattern with vitest.
 */
export const makeWithTestCtx = (options?: TestCtxOptions) => {
  const timeout = options?.timeout ?? 30_000

  return <A, E>(
    effect: Effect.Effect<A, E, NodeContext.NodeContext | Scope.Scope>,
  ): Promise<A> =>
    effect.pipe(
      Effect.scoped,
      Effect.provide(NodeContext.layer),
      Effect.timeout(Duration.millis(timeout)),
      Effect.catchTag('TimeoutException', () =>
        Effect.fail(new Error(`Test timed out after ${timeout}ms`) as unknown as E),
      ),
      Effect.runPromise,
    )
}

/** Default test context with 30 second timeout */
export const withTestCtx = makeWithTestCtx()
