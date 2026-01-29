/**
 * Mode Setup - Shared mode-specific rendering logic
 *
 * Provides the implementation for different output modes:
 * - final-visual: No progressive rendering
 * - final-json: JSON output on scope close
 * - progressive-json: NDJSON streaming on state changes
 *
 * @module
 */

import type { Scope } from 'effect'
import { Console, Deferred, Effect, Schema, Stream, SubscriptionRef } from 'effect'

// =============================================================================
// Mode Implementations
// =============================================================================

/**
 * Final visual mode: No progressive rendering.
 * The UI is not shown during execution.
 */
export const setupFinalVisual = (): Effect.Effect<void, never, Scope.Scope> => Effect.void

/**
 * Final JSON mode: Output final state as JSON on scope close.
 *
 * @param options.stateRef - The state SubscriptionRef
 * @param options.schema - Schema for encoding state to JSON
 */
export const setupFinalJson = <S>({
  stateRef,
  schema,
}: {
  stateRef: SubscriptionRef.SubscriptionRef<S>
  schema: Schema.Schema<S>
}): Effect.Effect<void, never, Scope.Scope> =>
  Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const finalState = yield* SubscriptionRef.get(stateRef)
      const encoded = yield* Schema.encode(schema)(finalState)
      yield* Console.log(JSON.stringify(encoded))
    }).pipe(Effect.orDie),
  )

/**
 * Progressive JSON mode: Stream state changes as NDJSON.
 * Each state change is immediately encoded and output as a JSON line.
 *
 * @param options.stateRef - The state SubscriptionRef
 * @param options.schema - Schema for encoding state to JSON
 */
export const setupProgressiveJson = <S>({
  stateRef,
  schema,
}: {
  stateRef: SubscriptionRef.SubscriptionRef<S>
  schema: Schema.Schema<S>
}): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    // Create a deferred to signal when the stream has started
    const started = yield* Deferred.make<void>()

    // Fork a fiber that streams state changes
    yield* stateRef.changes.pipe(
      // Signal that stream is subscribed on first item
      Stream.tap(() => Deferred.succeed(started, undefined)),
      Stream.tap((state) =>
        Schema.encode(schema)(state).pipe(
          Effect.flatMap((encoded) => Console.log(JSON.stringify(encoded))),
          Effect.orDie, // Schema encoding of valid state should never fail
        ),
      ),
      Stream.runDrain,
      Effect.forkScoped,
    )

    // Wait for the stream to process the initial value before returning
    // This ensures no state updates are missed due to race conditions
    yield* Deferred.await(started)
  })
