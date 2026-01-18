/**
 * Interrupt handler for terminal applications.
 *
 * When terminal is in raw mode (as pi-tui sets it), Ctrl+C is captured as
 * the \x03 character instead of sending SIGINT. This module provides
 * Effect-native interrupt handling that works with raw mode terminals.
 *
 * Features:
 * - Intercepts Ctrl+C (\x03) in raw mode
 * - Gracefully interrupts Effect fiber
 * - Properly cleans up stdin handler
 */

import type { Scope } from 'effect'
import { Effect, Fiber } from 'effect'

/** Ctrl+C character in raw mode */
const CTRL_C = '\x03'

/**
 * Interrupt handler configuration.
 */
export interface InterruptHandlerConfig {
  /** Callback before interrupt (for logging, cleanup, etc.) */
  readonly onInterrupt?: () => void
}

/**
 * Install an interrupt handler that listens for Ctrl+C and interrupts the given fiber.
 *
 * In raw mode terminals, Ctrl+C is received as \x03 instead of SIGINT.
 * This handler intercepts that character and gracefully interrupts the fiber.
 *
 * Must be used within a Scope to ensure proper cleanup.
 *
 * Usage:
 * ```ts
 * const fiber = yield* Effect.fork(myLongRunningEffect);
 * yield* InterruptHandler.install(fiber);
 * ```
 */
export const install = Effect.fn('InterruptHandler/install')(
  <A, E>(
    fiber: Fiber.RuntimeFiber<A, E>,
    config: InterruptHandlerConfig = {},
  ): Effect.Effect<void, never, Scope.Scope> =>
    Effect.gen(function* () {
      // Create handler that interrupts fiber on Ctrl+C
      const handler = (data: string) => {
        if (data === CTRL_C) {
          config.onInterrupt?.()
          // Use runFork to fire-and-forget the interrupt
          Effect.runFork(Fiber.interrupt(fiber))
        }
      }

      // Install handler
      process.stdin.on('data', handler)

      // Remove handler when scope closes
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          process.stdin.off('data', handler)
        }),
      )
    }),
)

/**
 * Create a self-interrupting scope that handles Ctrl+C.
 *
 * This is a convenience wrapper that:
 * 1. Runs the provided effect in a fiber
 * 2. Installs Ctrl+C handler for that fiber
 * 3. Awaits the fiber result
 *
 * Usage:
 * ```ts
 * yield* InterruptHandler.withInterruptHandler(
 *   Effect.gen(function* () {
 *     // Long running work...
 *   })
 * )
 * ```
 */
export const withInterruptHandler = Effect.fn('InterruptHandler/withInterruptHandler')(
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    config: InterruptHandlerConfig = {},
  ): Effect.Effect<A, E, R | Scope.Scope> =>
    Effect.gen(function* () {
      // Fork the effect
      const fiber = yield* Effect.fork(effect)

      // Install interrupt handler
      yield* install(fiber, config)

      // Await the fiber
      return yield* Fiber.join(fiber)
    }),
)

/**
 * InterruptHandler module.
 */
export const InterruptHandler = {
  install,
  withInterruptHandler,
}
