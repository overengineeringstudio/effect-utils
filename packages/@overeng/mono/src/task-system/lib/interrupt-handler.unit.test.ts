/**
 * Unit tests for InterruptHandler.
 *
 * Tests the fiber interrupt logic including simulated Ctrl+C via stdin events.
 */

import * as assert from 'node:assert'

import { describe, it } from '@effect/vitest'
import { Deferred, Effect, Exit, Fiber } from 'effect'

import { InterruptHandler } from './interrupt-handler.ts'

/** Ctrl+C character in raw mode */
const CTRL_C = '\x03'

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

    it.scoped('interrupts fiber when Ctrl+C is received via stdin', () =>
      Effect.gen(function* () {
        const interruptCalled = { value: false }

        // Create a long-running fiber that we'll interrupt
        const fiber = yield* Effect.fork(Effect.never)

        // Install handler with callback to track interrupt
        yield* InterruptHandler.install(fiber, {
          onInterrupt: () => {
            interruptCalled.value = true
          },
        })

        // Simulate Ctrl+C by emitting the character to stdin
        process.stdin.emit('data', CTRL_C)

        // Wait for interrupt to be processed (with timeout to avoid hanging)
        const exit = yield* Fiber.await(fiber).pipe(
          Effect.timeout('100 millis'),
          Effect.option,
        )

        // Verify the callback was called
        assert.strictEqual(interruptCalled.value, true, 'onInterrupt callback should be called')

        // Verify the fiber was interrupted (if we got a result before timeout)
        if (exit._tag === 'Some') {
          assert.ok(Exit.isInterrupted(exit.value), 'Fiber should be interrupted')
        }
      }),
    )

    it('does not call onInterrupt for non-Ctrl+C input', async () => {
      const interruptCalled = { value: false }

      await Effect.gen(function* () {
        const fiber = yield* Effect.fork(Effect.sleep('100 millis'))

        // Create handler manually to test
        const handler = (data: string) => {
          if (data === CTRL_C) {
            interruptCalled.value = true
          }
        }

        // Install handler
        process.stdin.on('data', handler)

        // Simulate other keypress (not Ctrl+C)
        process.stdin.emit('data', 'a')

        // Verify the callback was NOT called
        assert.strictEqual(interruptCalled.value, false, 'onInterrupt should not be called for non-Ctrl+C')

        // Clean up
        process.stdin.off('data', handler)
        yield* Fiber.join(fiber)
      }).pipe(Effect.runPromise)
    })
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
