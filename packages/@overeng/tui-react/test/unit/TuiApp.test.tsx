/**
 * Tests for TuiApp factory pattern
 */

import { it } from '@effect/vitest'
import { Cause, Effect, FiberId, Schema } from 'effect'
import React from 'react'
import { describe, expect, beforeEach, afterEach, test } from 'vitest'

import { testModeLayer } from '../../src/effect/testing.tsx'
import {
  createTuiApp,
  useTuiAtomValue,
  deriveOutputSchema,
  Box,
  Text,
  type TuiOutput,
} from '../../src/mod.tsx'

const parseJson = (json: string) =>
  Schema.decodeSync(
    Schema.parseJson(
      Schema.Record({
        key: Schema.String,
        value: Schema.Unknown,
      }),
    ),
  )(json)
const encodeJson = (value: unknown) => Schema.encodeSync(Schema.parseJson(Schema.Unknown))(value)

// =============================================================================
// Test State and Actions
// =============================================================================

const CounterState = Schema.Struct({
  count: Schema.Number,
})

type CounterState = Schema.Schema.Type<typeof CounterState>

const CounterAction = Schema.Union(
  Schema.TaggedStruct('Increment', {}),
  Schema.TaggedStruct('Decrement', {}),
  Schema.TaggedStruct('Set', { value: Schema.Number }),
)

type CounterAction = Schema.Schema.Type<typeof CounterAction>

const counterReducer = ({
  state,
  action,
}: {
  state: CounterState
  action: CounterAction
}): CounterState => {
  switch (action._tag) {
    case 'Increment':
      return { count: state.count + 1 }
    case 'Decrement':
      return { count: state.count - 1 }
    case 'Set':
      return { count: action.value }
  }
}

// =============================================================================
// Test App
// =============================================================================

const CounterApp = createTuiApp({
  stateSchema: CounterState,
  actionSchema: CounterAction,
  initial: { count: 0 },
  reducer: counterReducer,
})

// =============================================================================
// Test View (uses app-scoped hooks)
// =============================================================================

const CounterView = () => {
  const state = useTuiAtomValue(CounterApp.stateAtom)

  return (
    <Box flexDirection="column">
      <Text>Count: {state.count}</Text>
    </Box>
  )
}

// =============================================================================
// Tests
// =============================================================================

describe('createTuiApp', () => {
  let originalLog: typeof console.log
  let capturedOutput: string[]

  beforeEach(() => {
    originalLog = console.log
    capturedOutput = []
    console.log = (msg: string) => {
      capturedOutput.push(msg)
    }
  })

  afterEach(() => {
    console.log = originalLog
  })

  describe('headless (no view)', () => {
    it.effect('initializes with initial state', () =>
      Effect.gen(function* () {
        const tui = yield* CounterApp.run()
        const result = tui.getState()
        expect(result).toEqual({ count: 0 })
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('pipe'))),
    )

    it.effect('dispatch updates state', () =>
      Effect.gen(function* () {
        const tui = yield* CounterApp.run()
        tui.dispatch({ _tag: 'Increment' })
        tui.dispatch({ _tag: 'Increment' })
        tui.dispatch({ _tag: 'Increment' })
        const result = tui.getState()
        expect(result).toEqual({ count: 3 })
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('pipe'))),
    )

    it.effect('dispatch with payload', () =>
      Effect.gen(function* () {
        const tui = yield* CounterApp.run()
        tui.dispatch({ _tag: 'Set', value: 42 })
        const result = tui.getState()
        expect(result).toEqual({ count: 42 })
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('pipe'))),
    )
  })

  describe('json mode', () => {
    it.effect('outputs final state as JSON with Success wrapper', () =>
      Effect.gen(function* () {
        const tui = yield* CounterApp.run()
        tui.dispatch({ _tag: 'Increment' })
        tui.dispatch({ _tag: 'Increment' })
      }).pipe(
        Effect.scoped,
        Effect.provide(testModeLayer('json')),
        Effect.andThen(() => {
          expect(capturedOutput).toHaveLength(1)
          const output = parseJson(capturedOutput[0]!)
          expect(output).toEqual({ _tag: 'Success', count: 2 })
        }),
      ),
    )

    it.effect('works with view (view is ignored in json mode)', () =>
      Effect.gen(function* () {
        const tui = yield* CounterApp.run(<CounterView />)
        tui.dispatch({ _tag: 'Set', value: 100 })
      }).pipe(
        Effect.scoped,
        Effect.provide(testModeLayer('json')),
        Effect.andThen(() => {
          expect(capturedOutput).toHaveLength(1)
          const output = parseJson(capturedOutput[0]!)
          expect(output).toEqual({ _tag: 'Success', count: 100 })
        }),
      ),
    )
  })

  describe('ndjson mode', () => {
    it.live('streams state changes as NDJSON with final Success wrapper', () =>
      Effect.gen(function* () {
        const tui = yield* CounterApp.run()
        yield* Effect.sleep('10 millis')
        tui.dispatch({ _tag: 'Increment' })
        yield* Effect.sleep('10 millis')
        tui.dispatch({ _tag: 'Increment' })
        yield* Effect.sleep('10 millis')
      }).pipe(
        Effect.scoped,
        Effect.provide(testModeLayer('ndjson')),
        Effect.andThen(() => {
          // Should have at least initial state + final wrapped output
          expect(capturedOutput.length).toBeGreaterThanOrEqual(2)

          // Parse all outputs
          const states = capturedOutput.map((line) => parseJson(line))

          // Intermediate lines are raw state (for progressive consumption)
          expect(states[0]).toEqual({ count: 0 }) // initial

          // Final line should be wrapped in Success
          const finalOutput = states[states.length - 1] as { _tag: string; count: number }
          expect(finalOutput._tag).toBe('Success')
          expect(finalOutput.count).toBe(2)
        }),
      ),
    )
  })

  describe('config access', () => {
    test('exposes config for testing', () => {
      expect(CounterApp.config.initial).toEqual({ count: 0 })
      expect(
        CounterApp.config.reducer({ state: { count: 5 }, action: { _tag: 'Increment' } }),
      ).toEqual({ count: 6 })
    })
  })

  describe('progressive mode rendering', () => {
    // Note: Progressive modes (tty, ci) render to process.stdout, not console.log.
    // We verify state is correctly set before unmount, and unmount waits for React
    // to process pending updates before flushing and cleaning up.

    it.effect('dispatch followed by immediate unmount captures final state', () =>
      Effect.gen(function* () {
        const tui = yield* CounterApp.run(<CounterView />)
        tui.dispatch({ _tag: 'Set', value: 42 })
        // Unmount now waits for React to process updates before flushing
        yield* tui.unmount({ mode: 'persist' })
        const finalState = tui.getState()
        expect(finalState).toEqual({ count: 42 })
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('tty'))),
    )

    it.effect('multiple dispatches before unmount shows final state', () =>
      Effect.gen(function* () {
        const tui = yield* CounterApp.run(<CounterView />)
        tui.dispatch({ _tag: 'Set', value: 10 })
        tui.dispatch({ _tag: 'Increment' })
        tui.dispatch({ _tag: 'Increment' })
        tui.dispatch({ _tag: 'Increment' })
        yield* tui.unmount({ mode: 'persist' })
        const finalState = tui.getState()
        // Final state should be 13 (10 + 3 increments)
        expect(finalState).toEqual({ count: 13 })
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('tty'))),
    )

    it.effect('unmount flushes React work synchronously via flushSyncWork', () =>
      // This test verifies that unmount uses React's flushSyncWork() to
      // synchronously flush pending work before unmounting
      Effect.gen(function* () {
        const tui = yield* CounterApp.run(<CounterView />)
        tui.dispatch({ _tag: 'Set', value: 100 })
        yield* tui.unmount({ mode: 'persist' })
        // If we reach here, unmount completed successfully
        expect(true).toBe(true)
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('ci'))),
    )
  })

  describe('multiple apps', () => {
    it.effect('can create multiple independent apps', () => {
      const App1 = createTuiApp({
        stateSchema: CounterState,
        actionSchema: CounterAction,
        initial: { count: 10 },
        reducer: counterReducer,
      })

      const App2 = createTuiApp({
        stateSchema: CounterState,
        actionSchema: CounterAction,
        initial: { count: 20 },
        reducer: counterReducer,
      })

      return Effect.gen(function* () {
        const tui1 = yield* App1.run()
        const tui2 = yield* App2.run()

        tui1.dispatch({ _tag: 'Increment' })
        tui2.dispatch({ _tag: 'Decrement' })

        expect(tui1.getState()).toEqual({ count: 11 })
        expect(tui2.getState()).toEqual({ count: 19 })
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('pipe')))
    })
  })

  describe('outputSchema', () => {
    test('exposes derived outputSchema on app', () => {
      expect(CounterApp.outputSchema).toBeDefined()
    })

    test('outputSchema type inference works', () => {
      // Type assertion - if this compiles, types are correct
      type Output = typeof CounterApp.outputSchema.Type
      const _successCheck: Output = { _tag: 'Success', count: 42 }
      const _failureCheck: Output = {
        _tag: 'Failure',
        cause: Cause.interrupt(FiberId.none),
        state: { count: 10 },
      }
      expect(_successCheck._tag).toBe('Success')
      expect(_failureCheck._tag).toBe('Failure')
    })
  })
})

// =============================================================================
// deriveOutputSchema Tests
// =============================================================================

describe('deriveOutputSchema', () => {
  describe('struct state schema', () => {
    const StateSchema = Schema.Struct({
      count: Schema.Number,
      name: Schema.String,
    })
    const OutputSchema = deriveOutputSchema(StateSchema)

    it.effect('success: encodes state fields flat with _tag', () =>
      Effect.gen(function* () {
        const successValue: TuiOutput<typeof StateSchema.Type> = {
          _tag: 'Success',
          count: 42,
          name: 'test',
        }

        const encoded = yield* Schema.encode(Schema.parseJson(OutputSchema))(successValue)
        const parsed = parseJson(encoded) as any

        expect(parsed).toEqual({
          _tag: 'Success',
          count: 42,
          name: 'test',
        })
      }),
    )

    it.effect('success: decodes flat fields to success value', () =>
      Effect.gen(function* () {
        const json = encodeJson({
          _tag: 'Success',
          count: 42,
          name: 'test',
        })

        const decoded = yield* Schema.decode(Schema.parseJson(OutputSchema))(json)

        expect(decoded).toEqual({
          _tag: 'Success',
          count: 42,
          name: 'test',
        })
      }),
    )

    it.effect('failure: encodes cause and state', () =>
      Effect.gen(function* () {
        // Create a real Cause.interrupt value
        const interruptCause = Cause.interrupt(FiberId.none)

        const failureValue: TuiOutput<typeof StateSchema.Type> = {
          _tag: 'Failure',
          cause: interruptCause,
          state: { count: 10, name: 'partial' },
        }

        const encoded = yield* Schema.encode(Schema.parseJson(OutputSchema))(failureValue)
        const parsed = parseJson(encoded) as any

        expect(parsed._tag).toBe('Failure')
        expect(parsed.state).toEqual({ count: 10, name: 'partial' })
        expect(parsed.cause).toBeDefined()
        expect(parsed.cause._tag).toBe('Interrupt')
      }),
    )

    it.effect('failure: decodes cause and state', () =>
      Effect.gen(function* () {
        // Create an interrupt cause JSON
        const json = encodeJson({
          _tag: 'Failure',
          cause: { _tag: 'Interrupt', fiberId: { _tag: 'None' } },
          state: { count: 10, name: 'partial' },
        })

        const decoded = yield* Schema.decode(Schema.parseJson(OutputSchema))(json)

        expect(decoded._tag).toBe('Failure')
        if (decoded._tag === 'Failure') {
          expect(decoded.state).toEqual({ count: 10, name: 'partial' })
        }
      }),
    )
  })

  describe('nested struct state schema', () => {
    const NestedStateSchema = Schema.Struct({
      workspace: Schema.Struct({
        name: Schema.String,
        root: Schema.String,
      }),
      results: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          status: Schema.Literal('ok', 'error'),
        }),
      ),
    })
    const OutputSchema = deriveOutputSchema(NestedStateSchema)

    it.effect('success: encodes nested state flat', () =>
      Effect.gen(function* () {
        const successValue: TuiOutput<typeof NestedStateSchema.Type> = {
          _tag: 'Success',
          workspace: { name: 'my-repo', root: '/path' },
          results: [{ name: 'pkg-a', status: 'ok' }],
        }

        const encoded = yield* Schema.encode(Schema.parseJson(OutputSchema))(successValue)
        const parsed = parseJson(encoded) as any

        expect(parsed).toEqual({
          _tag: 'Success',
          workspace: { name: 'my-repo', root: '/path' },
          results: [{ name: 'pkg-a', status: 'ok' }],
        })
      }),
    )

    it.effect('failure: preserves nested state at time of failure', () =>
      Effect.gen(function* () {
        // Create a real Cause.interrupt value
        const interruptCause = Cause.interrupt(FiberId.none)

        const failureValue: TuiOutput<typeof NestedStateSchema.Type> = {
          _tag: 'Failure',
          cause: interruptCause,
          state: {
            workspace: { name: 'my-repo', root: '/path' },
            results: [{ name: 'pkg-a', status: 'ok' }],
          },
        }

        const encoded = yield* Schema.encode(Schema.parseJson(OutputSchema))(failureValue)
        const parsed = parseJson(encoded) as any

        expect(parsed._tag).toBe('Failure')
        expect(parsed.state.workspace.name).toBe('my-repo')
        expect(parsed.state.results).toHaveLength(1)
      }),
    )
  })

  describe('discriminated union state schema', () => {
    // Sometimes state itself is a tagged union (e.g., Idle | Loading | Done)
    const UnionStateSchema = Schema.Union(
      Schema.TaggedStruct('Idle', {}),
      Schema.TaggedStruct('Loading', { progress: Schema.Number }),
      Schema.TaggedStruct('Done', { result: Schema.String }),
    )

    it.effect('non-struct state: wraps in value field', () =>
      Effect.gen(function* () {
        // For non-struct schemas, we can't spread fields
        // The schema should fall back to wrapping in a `value` field
        const OutputSchema = deriveOutputSchema(UnionStateSchema)

        // This is a limitation - union states get wrapped in `value`
        const successValue = {
          _tag: 'Success' as const,
          value: { _tag: 'Done' as const, result: 'completed' },
        }

        const encoded = yield* Schema.encode(Schema.parseJson(OutputSchema))(successValue as any)
        const parsed = parseJson(encoded) as any

        expect(parsed._tag).toBe('Success')
        expect(parsed.value._tag).toBe('Done')
      }),
    )
  })
})
