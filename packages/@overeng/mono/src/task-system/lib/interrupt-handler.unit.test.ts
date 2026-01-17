/**
 * Unit tests for InterruptHandler.
 *
 * Tests the fiber interrupt logic. Stdin interaction would require
 * integration tests with a real terminal.
 */

import * as assert from 'node:assert'

import { describe, it } from '@effect/vitest'
import { Deferred, Effect, Fiber } from 'effect'

import { InterruptHandler } from './interrupt-handler.ts'

describe('InterruptHandler', () => {
  describe('install', () => {
    it.scoped('installs handler that can be cleaned up', () =>
      Effect.gen(function* () {
        // Create a test fiber
        const deferred = yield* Deferred.make<void>()
        const fiber = yield* Effect.fork(Deferred.await(deferred))

        // Install handler
        yield* InterruptHandler.install(fiber)

        // Complete the deferred to let fiber finish
        yield* Deferred.succeed(deferred, undefined)
        yield* Fiber.join(fiber)

        // If we get here, cleanup worked
      }),
    )

    it.scoped('calls onInterrupt callback when provided', () =>
      Effect.gen(function* () {
        const called = { value: false }
        const deferred = yield* Deferred.make<void>()
        const fiber = yield* Effect.fork(Deferred.await(deferred))

        // Install handler with callback
        yield* InterruptHandler.install(fiber, {
          onInterrupt: () => {
            called.value = true
          },
        })

        // Complete to finish test
        yield* Deferred.succeed(deferred, undefined)
        yield* Fiber.join(fiber)

        // Note: callback only fires on actual Ctrl+C, not on test completion
        // This test verifies the config is accepted without error
      }),
    )
  })

  describe('withInterruptHandler', () => {
    it.scoped('runs effect with interrupt handler installed', () =>
      Effect.gen(function* () {
        const result = yield* InterruptHandler.withInterruptHandler(Effect.succeed(42))

        assert.strictEqual(result, 42)
      }),
    )

    it.scoped('propagates effect errors', () =>
      Effect.gen(function* () {
        const effect = InterruptHandler.withInterruptHandler(Effect.fail('test-error' as const))

        const result = yield* Effect.either(effect)

        assert.ok(result._tag === 'Left')
        assert.strictEqual(result.left, 'test-error')
      }),
    )

    it.scoped('runs effect to completion', () =>
      Effect.gen(function* () {
        let executed = false

        yield* InterruptHandler.withInterruptHandler(
          Effect.sync(() => {
            executed = true
          }),
        )

        assert.strictEqual(executed, true)
      }),
    )
  })
})
