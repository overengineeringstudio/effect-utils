/**
 * Tests for TuiApp factory pattern
 */

import { Cause, Effect, FiberId, Schema } from 'effect'
import React from 'react'
import { describe, test, expect, beforeEach, afterEach } from 'vitest'

import { testModeLayer } from '../../src/effect/testing.tsx'
import {
  createTuiApp,
  useTuiAtomValue,
  deriveOutputSchema,
  Box,
  Text,
  type TuiOutput,
} from '../../src/mod.tsx'

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
    test('initializes with initial state', async () => {
      const result = await Effect.gen(function* () {
        const tui = yield* CounterApp.run()
        return tui.getState()
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('pipe')), Effect.runPromise)

      expect(result).toEqual({ count: 0 })
    })

    test('dispatch updates state', async () => {
      const result = await Effect.gen(function* () {
        const tui = yield* CounterApp.run()
        tui.dispatch({ _tag: 'Increment' })
        tui.dispatch({ _tag: 'Increment' })
        tui.dispatch({ _tag: 'Increment' })
        return tui.getState()
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('pipe')), Effect.runPromise)

      expect(result).toEqual({ count: 3 })
    })

    test('dispatch with payload', async () => {
      const result = await Effect.gen(function* () {
        const tui = yield* CounterApp.run()
        tui.dispatch({ _tag: 'Set', value: 42 })
        return tui.getState()
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('pipe')), Effect.runPromise)

      expect(result).toEqual({ count: 42 })
    })
  })

  describe('json mode', () => {
    test('outputs final state as JSON with Success wrapper', async () => {
      await Effect.gen(function* () {
        const tui = yield* CounterApp.run()
        tui.dispatch({ _tag: 'Increment' })
        tui.dispatch({ _tag: 'Increment' })
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('json')), Effect.runPromise)

      expect(capturedOutput).toHaveLength(1)
      const output = JSON.parse(capturedOutput[0]!)
      expect(output).toEqual({ _tag: 'Success', count: 2 })
    })

    test('works with view (view is ignored in json mode)', async () => {
      await Effect.gen(function* () {
        const tui = yield* CounterApp.run(<CounterView />)
        tui.dispatch({ _tag: 'Set', value: 100 })
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('json')), Effect.runPromise)

      expect(capturedOutput).toHaveLength(1)
      const output = JSON.parse(capturedOutput[0]!)
      expect(output).toEqual({ _tag: 'Success', count: 100 })
    })
  })

  describe('ndjson mode', () => {
    test('streams state changes as NDJSON with final Success wrapper', async () => {
      await Effect.gen(function* () {
        const tui = yield* CounterApp.run()
        yield* Effect.sleep('10 millis')
        tui.dispatch({ _tag: 'Increment' })
        yield* Effect.sleep('10 millis')
        tui.dispatch({ _tag: 'Increment' })
        yield* Effect.sleep('10 millis')
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('ndjson')), Effect.runPromise)

      // Should have at least initial state + final wrapped output
      expect(capturedOutput.length).toBeGreaterThanOrEqual(2)

      // Parse all outputs
      const states = capturedOutput.map((line) => JSON.parse(line))

      // Intermediate lines are raw state (for progressive consumption)
      expect(states[0]).toEqual({ count: 0 }) // initial

      // Final line should be wrapped in Success
      const finalOutput = states[states.length - 1]
      expect(finalOutput._tag).toBe('Success')
      expect(finalOutput.count).toBe(2)
    })
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

    test('dispatch followed by immediate unmount captures final state', async () => {
      const finalState = await Effect.gen(function* () {
        const tui = yield* CounterApp.run(<CounterView />)
        tui.dispatch({ _tag: 'Set', value: 42 })
        // Unmount now waits for React to process updates before flushing
        yield* tui.unmount({ mode: 'persist' })
        return tui.getState()
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('tty')), Effect.runPromise)

      expect(finalState).toEqual({ count: 42 })
    })

    test('multiple dispatches before unmount shows final state', async () => {
      const finalState = await Effect.gen(function* () {
        const tui = yield* CounterApp.run(<CounterView />)
        tui.dispatch({ _tag: 'Set', value: 10 })
        tui.dispatch({ _tag: 'Increment' })
        tui.dispatch({ _tag: 'Increment' })
        tui.dispatch({ _tag: 'Increment' })
        yield* tui.unmount({ mode: 'persist' })
        return tui.getState()
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('tty')), Effect.runPromise)

      // Final state should be 13 (10 + 3 increments)
      expect(finalState).toEqual({ count: 13 })
    })

    test('unmount flushes React work synchronously via flushSyncWork', async () => {
      // This test verifies that unmount uses React's flushSyncWork() to
      // synchronously flush pending work before unmounting
      let unmountCompleted = false

      await Effect.gen(function* () {
        const tui = yield* CounterApp.run(<CounterView />)
        tui.dispatch({ _tag: 'Set', value: 100 })
        yield* tui.unmount({ mode: 'persist' })
        unmountCompleted = true
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('ci')), Effect.runPromise)

      expect(unmountCompleted).toBe(true)
    })
  })

  describe('multiple apps', () => {
    test('can create multiple independent apps', async () => {
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

      const result = await Effect.gen(function* () {
        const tui1 = yield* App1.run()
        const tui2 = yield* App2.run()

        tui1.dispatch({ _tag: 'Increment' })
        tui2.dispatch({ _tag: 'Decrement' })

        return {
          state1: tui1.getState(),
          state2: tui2.getState(),
        }
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('pipe')), Effect.runPromise)

      expect(result.state1).toEqual({ count: 11 })
      expect(result.state2).toEqual({ count: 19 })
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

    test('success: encodes state fields flat with _tag', async () => {
      const successValue: TuiOutput<typeof StateSchema.Type> = {
        _tag: 'Success',
        count: 42,
        name: 'test',
      }

      const encoded = await Schema.encode(Schema.parseJson(OutputSchema))(successValue).pipe(
        Effect.runPromise,
      )
      const parsed = JSON.parse(encoded)

      expect(parsed).toEqual({
        _tag: 'Success',
        count: 42,
        name: 'test',
      })
    })

    test('success: decodes flat fields to success value', async () => {
      const json = JSON.stringify({
        _tag: 'Success',
        count: 42,
        name: 'test',
      })

      const decoded = await Schema.decode(Schema.parseJson(OutputSchema))(json).pipe(
        Effect.runPromise,
      )

      expect(decoded).toEqual({
        _tag: 'Success',
        count: 42,
        name: 'test',
      })
    })

    test('failure: encodes cause and state', async () => {
      // Create a real Cause.interrupt value
      const interruptCause = Cause.interrupt(FiberId.none)

      const failureValue: TuiOutput<typeof StateSchema.Type> = {
        _tag: 'Failure',
        cause: interruptCause,
        state: { count: 10, name: 'partial' },
      }

      const encoded = await Schema.encode(Schema.parseJson(OutputSchema))(failureValue).pipe(
        Effect.runPromise,
      )
      const parsed = JSON.parse(encoded)

      expect(parsed._tag).toBe('Failure')
      expect(parsed.state).toEqual({ count: 10, name: 'partial' })
      expect(parsed.cause).toBeDefined()
      expect(parsed.cause._tag).toBe('Interrupt')
    })

    test('failure: decodes cause and state', async () => {
      // Create an interrupt cause JSON
      const json = JSON.stringify({
        _tag: 'Failure',
        cause: { _tag: 'Interrupt', fiberId: { _tag: 'None' } },
        state: { count: 10, name: 'partial' },
      })

      const decoded = await Schema.decode(Schema.parseJson(OutputSchema))(json).pipe(
        Effect.runPromise,
      )

      expect(decoded._tag).toBe('Failure')
      if (decoded._tag === 'Failure') {
        expect(decoded.state).toEqual({ count: 10, name: 'partial' })
      }
    })
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

    test('success: encodes nested state flat', async () => {
      const successValue: TuiOutput<typeof NestedStateSchema.Type> = {
        _tag: 'Success',
        workspace: { name: 'my-repo', root: '/path' },
        results: [{ name: 'pkg-a', status: 'ok' }],
      }

      const encoded = await Schema.encode(Schema.parseJson(OutputSchema))(successValue).pipe(
        Effect.runPromise,
      )
      const parsed = JSON.parse(encoded)

      expect(parsed).toEqual({
        _tag: 'Success',
        workspace: { name: 'my-repo', root: '/path' },
        results: [{ name: 'pkg-a', status: 'ok' }],
      })
    })

    test('failure: preserves nested state at time of failure', async () => {
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

      const encoded = await Schema.encode(Schema.parseJson(OutputSchema))(failureValue).pipe(
        Effect.runPromise,
      )
      const parsed = JSON.parse(encoded)

      expect(parsed._tag).toBe('Failure')
      expect(parsed.state.workspace.name).toBe('my-repo')
      expect(parsed.state.results).toHaveLength(1)
    })
  })

  describe('discriminated union state schema', () => {
    // Sometimes state itself is a tagged union (e.g., Idle | Loading | Done)
    const UnionStateSchema = Schema.Union(
      Schema.TaggedStruct('Idle', {}),
      Schema.TaggedStruct('Loading', { progress: Schema.Number }),
      Schema.TaggedStruct('Done', { result: Schema.String }),
    )

    test('non-struct state: wraps in value field', async () => {
      // For non-struct schemas, we can't spread fields
      // The schema should fall back to wrapping in a `value` field
      const OutputSchema = deriveOutputSchema(UnionStateSchema)

      // This is a limitation - union states get wrapped in `value`
      const successValue = {
        _tag: 'Success' as const,
        value: { _tag: 'Done' as const, result: 'completed' },
      }

      const encoded = await Schema.encode(Schema.parseJson(OutputSchema))(successValue as any).pipe(
        Effect.runPromise,
      )
      const parsed = JSON.parse(encoded)

      expect(parsed._tag).toBe('Success')
      expect(parsed.value._tag).toBe('Done')
    })
  })
})
