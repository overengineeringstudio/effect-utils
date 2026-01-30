/**
 * Mode Setup - Shared mode-specific rendering logic
 *
 * Provides the implementation for different output modes:
 * - final-visual: Render to string on scope close
 * - final-json: JSON output on scope close
 * - progressive-json: NDJSON streaming on state changes
 *
 * @module
 */

import type { Scope } from 'effect'
import type { ReactElement } from 'react'
import { Console, Deferred, Effect, Schema, Stream, SubscriptionRef } from 'effect'
import React from 'react'

import { renderToString } from '../renderToString.ts'
import { RenderConfigProvider, stripAnsi, type RenderConfig } from './OutputMode.tsx'

// =============================================================================
// Mode Implementations
// =============================================================================

/**
 * Final visual mode: Render to string on scope close.
 * The UI is rendered once at the end and output to stdout.
 *
 * @param options.stateRef - The state SubscriptionRef
 * @param options.view - The React view to render
 * @param options.StateContext - Context for state
 * @param options.DispatchContext - Context for dispatch
 * @param options.dispatch - Dispatch function
 * @param options.renderConfig - Render configuration
 */
export const setupFinalVisual = <S, A>({
  stateRef,
  view,
  StateContext,
  DispatchContext,
  dispatch,
  renderConfig,
}: {
  stateRef: SubscriptionRef.SubscriptionRef<S>
  view: ReactElement | undefined
  StateContext: React.Context<SubscriptionRef.SubscriptionRef<S> | null>
  DispatchContext: React.Context<((action: A) => void) | null>
  dispatch: (action: A) => void
  renderConfig: RenderConfig
}): Effect.Effect<void, never, Scope.Scope> => {
  if (!view) return Effect.void

  return Effect.addFinalizer(() =>
    Effect.gen(function* () {
      // Create wrapper with context using React.createElement
      const innerElement = React.createElement(
        StateContext.Provider,
        { value: stateRef },
        React.createElement(DispatchContext.Provider, { value: dispatch }, view),
      )
      const element = React.createElement(RenderConfigProvider, {
        config: renderConfig,
        children: innerElement,
      })

      // Render to string
      const output = yield* Effect.promise(() => renderToString({ element }))

      // Strip ANSI codes if colors are disabled
      const finalOutput = renderConfig.colors ? output : stripAnsi(output)

      // Output to stdout
      yield* Console.log(finalOutput)
    }).pipe(Effect.orDie),
  )
}

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
      const jsonString = yield* Schema.encode(Schema.parseJson(schema))(finalState)
      yield* Console.log(jsonString)
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
        Schema.encode(Schema.parseJson(schema))(state).pipe(
          Effect.flatMap((jsonString) => Console.log(jsonString)),
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
