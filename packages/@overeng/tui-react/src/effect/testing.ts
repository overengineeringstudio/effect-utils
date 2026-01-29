/**
 * Test utilities for tui-react Effect CLI integration.
 *
 * Provides helpers for testing commands that use createTuiApp.
 *
 * @example
 * ```typescript
 * import { runTestCommand, createTestTuiState } from '@overeng/tui-react'
 *
 * test('deploy command outputs JSON', async () => {
 *   const { jsonOutput, finalState } = await runTestCommand(runDeploy, {
 *     args: ['api-server'],
 *     mode: 'final-json',
 *   })
 *
 *   expect(finalState._tag).toBe('Complete')
 * })
 * ```
 */

import type { Scope } from 'effect'
import { Effect, Layer, PubSub, Schema, Stream, SubscriptionRef } from 'effect'

import {
  type OutputMode,
  OutputModeTag,
  finalJson,
  finalVisual,
  progressiveJson,
  progressiveVisual,
  progressiveVisualAlternate,
} from './OutputMode.ts'
import type { TuiAppConfig, TuiAppApi } from './TuiApp.tsx'

// =============================================================================
// Types
// =============================================================================

/**
 * Options for running a test command.
 */
export interface RunTestCommandOptions<Args> {
  /** Command arguments */
  args: Args
  /** Output mode to use */
  mode: OutputMode['_tag']
}

/**
 * Result of running a test command.
 */
export interface TestCommandResult<S> {
  /** All state values emitted during execution (from JSON output) */
  states: S[]
  /** Final state value */
  finalState: S
  /** Captured JSON output lines */
  jsonOutput: string[]
}

/**
 * Options for capturing output.
 */
export interface CaptureOptions {
  /** Capture console.log calls */
  captureLog?: boolean
  /** Capture console.error calls */
  captureError?: boolean
}

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Convert mode tag to OutputMode value.
 */
export const modeFromTag = (tag: OutputMode['_tag']): OutputMode => {
  switch (tag) {
    case 'progressive-visual':
      return progressiveVisual
    case 'progressive-visual-alternate':
      return progressiveVisualAlternate
    case 'final-visual':
      return finalVisual
    case 'final-json':
      return finalJson
    case 'progressive-json':
      return progressiveJson
  }
}

/**
 * Create a layer for a specific output mode.
 */
export const testModeLayer = (tag: OutputMode['_tag']): Layer.Layer<OutputModeTag> =>
  Layer.succeed(OutputModeTag, modeFromTag(tag))

/**
 * Run a command function with test utilities.
 *
 * Captures state changes and output, returning them for assertions.
 *
 * @example
 * ```typescript
 * const result = await runTestCommand({
 *   commandFn: (services) => runDeploy(services),
 *   options: { args: ['api-server'], mode: 'final-json' }
 * })
 *
 * expect(result.finalState._tag).toBe('Complete')
 * ```
 */
export const runTestCommand = async <S, Args>({
  commandFn,
  options,
}: {
  commandFn: (args: Args) => Effect.Effect<unknown, unknown, Scope.Scope | OutputModeTag>
  options: RunTestCommandOptions<Args>
}): Promise<TestCommandResult<S>> => {
  const jsonOutput: string[] = []

  // Capture console.log for JSON output
  const originalLog = console.log
  console.log = (msg: string) => {
    jsonOutput.push(msg)
  }

  try {
    await Effect.gen(function* () {
      yield* commandFn(options.args)
    }).pipe(Effect.scoped, Effect.provide(testModeLayer(options.mode)), Effect.runPromise)
  } finally {
    console.log = originalLog
  }

  // Parse JSON output to get states
  const parsedStates = jsonOutput
    .map((line) => {
      try {
        return JSON.parse(line) as S
      } catch {
        return null
      }
    })
    .filter((s): s is S => s !== null)

  return {
    states: parsedStates,
    finalState: parsedStates[parsedStates.length - 1]!,
    jsonOutput,
  }
}

/**
 * Create a test version of TUI state that captures state changes and actions.
 *
 * @example
 * ```typescript
 * const { api, getStates, getActions } = await Effect.runPromise(
 *   createTestTuiState({
 *     stateSchema: CounterState,
 *     actionSchema: CounterAction,
 *     initial: { count: 0 },
 *     reducer: counterReducer,
 *   }).pipe(Effect.scoped)
 * )
 *
 * api.dispatch({ _tag: 'Increment' })
 * api.dispatch({ _tag: 'Increment' })
 *
 * expect(getStates()).toEqual([{ count: 0 }, { count: 1 }, { count: 2 }])
 * expect(getActions()).toHaveLength(2)
 * ```
 */
export const createTestTuiState = <S, A>(
  config: TuiAppConfig<S, A>,
): Effect.Effect<
  {
    api: TuiAppApi<S, A>
    getStates: () => S[]
    getActions: () => A[]
    getFinalState: () => S
  },
  never,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const { initial, reducer } = config
    // States array captures all state changes synchronously
    const states: S[] = [initial]
    const actions: A[] = []

    const stateRef = yield* SubscriptionRef.make(initial)
    const actionPubSub = yield* PubSub.unbounded<A>()

    // Create sync dispatch function that captures states and actions directly
    const dispatch = (action: A): void => {
      // First, apply the reducer
      Effect.runSync(SubscriptionRef.update(stateRef, (state) => reducer({ state, action })))
      // Capture the new state synchronously
      const newState = Effect.runSync(SubscriptionRef.get(stateRef))
      states.push(newState)
      // Capture the action
      actions.push(action)
      // Also publish to PubSub for the actions stream
      Effect.runFork(PubSub.publish(actionPubSub, action))
    }

    const api: TuiAppApi<S, A> = {
      dispatch,
      getState: () => Effect.runSync(SubscriptionRef.get(stateRef)),
      stateRef,
      actions: Stream.fromPubSub(actionPubSub),
      unmount: () => Effect.void,
    }

    return {
      api,
      getStates: () => [...states],
      getActions: () => [...actions],
      getFinalState: () => states[states.length - 1]!,
    }
  })

/**
 * Capture console output during an effect.
 *
 * @example
 * ```typescript
 * const { output, errors } = await captureConsole({
 *   effect: Effect.gen(function* () {
 *     yield* Console.log('hello')
 *     yield* Console.error('oops')
 *   })
 * })
 *
 * expect(output).toContain('hello')
 * expect(errors).toContain('oops')
 * ```
 */
export const captureConsole = async <A, E, R>({
  effect,
  options = { captureLog: true, captureError: true },
}: {
  effect: Effect.Effect<A, E, R>
  options?: CaptureOptions
}): Promise<{ output: string[]; errors: string[]; result: A }> => {
  const output: string[] = []
  const errors: string[] = []

  const originalLog = console.log
  const originalError = console.error

  if (options.captureLog) {
    console.log = (...args: unknown[]) => {
      output.push(args.map(String).join(' '))
    }
  }

  if (options.captureError) {
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    }
  }

  try {
    const result = await Effect.runPromise(effect as Effect.Effect<A, E, never>)
    return { output, errors, result }
  } finally {
    console.log = originalLog
    console.error = originalError
  }
}

/**
 * Assert that JSON output matches a schema.
 *
 * @example
 * ```typescript
 * const output = '{"_tag":"Complete","duration":1000}'
 * assertJsonMatchesSchema({ jsonString: output, schema: DeployState })
 * ```
 */
export const assertJsonMatchesSchema = <S, I>({
  jsonString,
  schema,
}: {
  jsonString: string
  schema: Schema.Schema<S, I>
}): S => {
  const parsed = JSON.parse(jsonString)
  return Schema.decodeUnknownSync(schema)(parsed)
}

/**
 * Create a mock view component that tracks renders.
 * The view uses hooks to access state.
 */
export const createMockView = <_S, _A>(): {
  View: () => null
  getRenderCount: () => number
} => {
  let renderCount = 0

  const View = (): null => {
    renderCount++
    return null
  }

  return {
    View,
    getRenderCount: () => renderCount,
  }
}
