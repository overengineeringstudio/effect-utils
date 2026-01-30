/**
 * Tests for TuiApp factory pattern
 */

import { Effect, Schema } from 'effect'
import React from 'react'
import { describe, test, expect, beforeEach, afterEach } from 'vitest'

import { testModeLayer } from '../../src/effect/testing.ts'
import { createTuiApp, Box, Text } from '../../src/mod.ts'

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
  const state = CounterApp.useState()
  const _dispatch = CounterApp.useDispatch()

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
    test('outputs final state as JSON', async () => {
      await Effect.gen(function* () {
        const tui = yield* CounterApp.run()
        tui.dispatch({ _tag: 'Increment' })
        tui.dispatch({ _tag: 'Increment' })
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('json')), Effect.runPromise)

      expect(capturedOutput).toHaveLength(1)
      expect(JSON.parse(capturedOutput[0]!)).toEqual({ count: 2 })
    })

    test('works with view (view is ignored in json mode)', async () => {
      await Effect.gen(function* () {
        const tui = yield* CounterApp.run(<CounterView />)
        tui.dispatch({ _tag: 'Set', value: 100 })
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('json')), Effect.runPromise)

      expect(capturedOutput).toHaveLength(1)
      expect(JSON.parse(capturedOutput[0]!)).toEqual({ count: 100 })
    })
  })

  describe('ndjson mode', () => {
    test('streams state changes as NDJSON', async () => {
      await Effect.gen(function* () {
        const tui = yield* CounterApp.run()
        yield* Effect.sleep('10 millis')
        tui.dispatch({ _tag: 'Increment' })
        yield* Effect.sleep('10 millis')
        tui.dispatch({ _tag: 'Increment' })
        yield* Effect.sleep('10 millis')
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('ndjson')), Effect.runPromise)

      expect(capturedOutput.length).toBeGreaterThanOrEqual(1)

      // Parse all outputs
      const states = capturedOutput.map((line) => JSON.parse(line))

      // Should see progression
      expect(states[0]).toEqual({ count: 0 }) // initial
      if (states.length >= 3) {
        expect(states[states.length - 1]).toEqual({ count: 2 }) // final
      }
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
})
