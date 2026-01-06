/**
 * Debug utilities for tracing scope and finalizer lifecycle.
 *
 * Helps diagnose issues like:
 * - Why a scope isn't closing (stuck finalizer)
 * - Order of finalizer execution
 * - Which finalizers are registered and when
 */

import { Effect, Exit, FiberRef, Scope } from 'effect'

/** Info about a registered finalizer for debugging */
export interface FinalizerInfo {
  readonly name: string
  readonly registeredAt: number
  readonly stackTrace?: string
}

/** Info about finalizer execution */
export interface FinalizerExecutionInfo extends FinalizerInfo {
  readonly startedAt: number
  readonly completedAt?: number
  readonly durationMs?: number
  readonly exit?: Exit.Exit<unknown, unknown>
}

/**
 * FiberRef to track whether scope debugging is enabled for the current fiber.
 * When enabled, `addTracedFinalizer` will log registration and execution.
 */
export const ScopeDebugEnabled = FiberRef.unsafeMake(false)

/**
 * Enables scope debugging for an effect and its children.
 *
 * When enabled:
 * - `addTracedFinalizer` logs registration and execution
 *
 * @example
 * ```ts
 * yield* withScopeDebug(myEffect)
 * ```
 */
export const withScopeDebug = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.locally(effect, ScopeDebugEnabled, true)

/**
 * Adds a finalizer with debug tracing.
 *
 * When scope debugging is enabled (via `withScopeDebug`):
 * - Logs when the finalizer is registered
 * - Logs when execution starts
 * - Logs when execution completes with duration
 *
 * When debugging is disabled, behaves identically to `Scope.addFinalizer`.
 *
 * @example
 * ```ts
 * yield* addTracedFinalizer({ name: 'cleanup-database', finalizer: Effect.log('Closing DB connection') })
 * ```
 */
export const addTracedFinalizer = (opts: { name: string; finalizer: Effect.Effect<void> }) =>
  Effect.gen(function* () {
    const { name, finalizer } = opts
    const debugEnabled = yield* FiberRef.get(ScopeDebugEnabled)
    const scope = yield* Effect.scope

    if (!debugEnabled) {
      yield* Scope.addFinalizer(scope, finalizer)
      return
    }

    const registeredAt = Date.now()

    yield* Effect.logDebug(`Finalizer registered: ${name}`, {
      finalizer: name,
      registeredAt: new Date(registeredAt).toISOString(),
    })

    const tracedFinalizer = (exit: Exit.Exit<unknown, unknown>) =>
      Effect.gen(function* () {
        const startedAt = Date.now()

        yield* Effect.logDebug(`Finalizer starting: ${name}`, {
          finalizer: name,
          timeSinceRegistration: `${startedAt - registeredAt}ms`,
          exitSuccess: Exit.isSuccess(exit),
        })

        yield* finalizer

        const completedAt = Date.now()
        const durationMs = completedAt - startedAt

        yield* Effect.logDebug(`Finalizer completed: ${name}`, {
          finalizer: name,
          durationMs,
        })
      }).pipe(
        Effect.catchAllCause((cause) =>
          Effect.logError(`Finalizer failed: ${name}`, {
            finalizer: name,
            cause,
          }).pipe(Effect.andThen(Effect.failCause(cause))),
        ),
      )

    yield* Scope.addFinalizerExit(scope, tracedFinalizer)
  })

/**
 * Runs an effect within a new scope that traces all finalizer activity.
 *
 * This is a higher-level API that:
 * 1. Creates a new scope
 * 2. Enables scope debugging
 * 3. Runs the effect
 * 4. Logs when the scope closes
 *
 * Use this when you want to trace an entire scope's lifecycle without
 * modifying individual finalizer registrations.
 *
 * @example
 * ```ts
 * yield* withTracedScope('database-transaction')(
 *   Effect.gen(function* () {
 *     yield* Effect.addFinalizer(() => Effect.log('Rolling back if needed'))
 *     // ... transaction logic ...
 *   })
 * )
 * ```
 */
export const withTracedScope =
  (label: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, Scope.Scope>> => {
    const createdAt = Date.now()

    return Effect.logDebug(`Traced scope starting: ${label}`, {
      scope: label,
      createdAt: new Date(createdAt).toISOString(),
    }).pipe(
      Effect.andThen(
        withScopeDebug(effect).pipe(
          Effect.onExit((exit) =>
            Effect.logDebug(`Traced scope closing: ${label}`, {
              scope: label,
              lifetimeMs: Date.now() - createdAt,
              exitSuccess: Exit.isSuccess(exit),
            }),
          ),
        ),
      ),
      Effect.scoped,
    )
  }

/**
 * Utility to wrap an existing finalizer effect with tracing.
 *
 * Use this when you can't modify the finalizer registration but want to
 * add tracing around an existing finalizer effect.
 *
 * @example
 * ```ts
 * const tracedCleanup = traceFinalizer({ name: 'db-cleanup', finalizer: originalCleanupEffect })
 * yield* Effect.addFinalizer(() => tracedCleanup)
 * ```
 */
export const traceFinalizer = (opts: {
  name: string
  finalizer: Effect.Effect<void>
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const { name, finalizer } = opts
    const debugEnabled = yield* FiberRef.get(ScopeDebugEnabled)

    if (!debugEnabled) {
      yield* finalizer
      return
    }

    const startedAt = Date.now()

    yield* Effect.logDebug(`Finalizer starting: ${name}`, {
      finalizer: name,
    })

    yield* finalizer

    const durationMs = Date.now() - startedAt

    yield* Effect.logDebug(`Finalizer completed: ${name}`, {
      finalizer: name,
      durationMs,
    })
  })
