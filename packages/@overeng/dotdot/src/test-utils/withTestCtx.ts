/**
 * Test context utilities for dotdot integration tests
 *
 * Provides automatic layer composition, timeout management, and scoped resource cleanup.
 */

import { NodeContext } from '@effect/platform-node'
import { Duration, Effect, Layer, type Scope } from 'effect'
import type { TestContext } from 'vitest'

export type WithTestCtxParams = {
  suffix?: string
  timeout?: number
}

const DEFAULT_TIMEOUT = Duration.toMillis(Duration.seconds(30))

/**
 * Creates a test context wrapper that provides layers and handles cleanup.
 *
 * Usage:
 * ```ts
 * const withTestCtx = makeWithTestCtx()
 *
 * it('my test', async (test) => {
 *   await withTestCtx(test)(
 *     Effect.gen(function* () {
 *       // test body with access to FileSystem, etc.
 *     })
 *   )
 * })
 * ```
 */
export const makeWithTestCtx =
  (params: WithTestCtxParams = {}) =>
  (_test: TestContext) =>
  <A, E>(self: Effect.Effect<A, E, NodeContext.NodeContext | Scope.Scope>): Promise<A> => {
    const timeout = params.timeout ?? DEFAULT_TIMEOUT

    // Create test layer with NodeContext
    const TestLayer = Layer.mergeAll(NodeContext.layer)

    return Effect.runPromise(
      self.pipe(
        Effect.provide(TestLayer),
        Effect.scoped,
        Effect.timeout(Duration.millis(timeout)),
        Effect.catchTag('TimeoutException', () =>
          Effect.die(new Error(`Test timed out after ${timeout}ms`)),
        ),
      ),
    )
  }

/** Default test context for most integration tests */
export const withTestCtx = makeWithTestCtx()
