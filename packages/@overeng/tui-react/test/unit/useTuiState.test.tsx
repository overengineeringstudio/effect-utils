/**
 * Tests for TuiApp (createTuiApp pattern)
 */

import { Effect, Schema, SubscriptionRef } from 'effect'
import { describe, test, expect, beforeEach, afterEach } from 'vitest'

import { createTestTuiState, testModeLayer } from '../../src/effect/testing.ts'
import { createTuiApp } from '../../src/effect/TuiApp.tsx'

// =============================================================================
// Test State and Action Schemas
// =============================================================================

const TestState = Schema.Union(
  Schema.TaggedStruct('Idle', {}),
  Schema.TaggedStruct('Running', {
    count: Schema.Number,
  }),
  Schema.TaggedStruct('Complete', {
    total: Schema.Number,
  }),
)

type TestState = Schema.Schema.Type<typeof TestState>

const TestAction = Schema.Union(
  Schema.TaggedStruct('Start', {}),
  Schema.TaggedStruct('Increment', {}),
  Schema.TaggedStruct('Finish', { total: Schema.Number }),
)

type TestAction = Schema.Schema.Type<typeof TestAction>

// =============================================================================
// Reducer
// =============================================================================

const testReducer = ({
  state,
  action,
}: {
  state: TestState
  action: TestAction
}): TestState => {
  switch (action._tag) {
    case 'Start':
      return { _tag: 'Running', count: 0 }
    case 'Increment':
      if (state._tag === 'Running') {
        return { _tag: 'Running', count: state.count + 1 }
      }
      return state
    case 'Finish':
      return { _tag: 'Complete', total: action.total }
  }
}

// =============================================================================
// Test App
// =============================================================================

const TestApp = createTuiApp({
  stateSchema: TestState,
  actionSchema: TestAction,
  initial: { _tag: 'Idle' } as TestState,
  reducer: testReducer,
})

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

  describe('state management', () => {
    test('initializes with provided initial state', async () => {
      const result = await Effect.gen(function* () {
        const tui = yield* TestApp.run()
        return tui.getState()
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('final-visual')), Effect.runPromise)

      expect(result).toEqual({ _tag: 'Idle' })
    })

    test('dispatch updates state via reducer', async () => {
      const result = await Effect.gen(function* () {
        const tui = yield* TestApp.run()
        tui.dispatch({ _tag: 'Start' })
        return tui.getState()
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('final-visual')), Effect.runPromise)

      expect(result).toEqual({ _tag: 'Running', count: 0 })
    })

    test('multiple dispatches apply reducer sequentially', async () => {
      const result = await Effect.gen(function* () {
        const tui = yield* TestApp.run()
        tui.dispatch({ _tag: 'Start' })
        tui.dispatch({ _tag: 'Increment' })
        tui.dispatch({ _tag: 'Increment' })
        tui.dispatch({ _tag: 'Increment' })
        return tui.getState()
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('final-visual')), Effect.runPromise)

      expect(result).toEqual({ _tag: 'Running', count: 3 })
    })

    test('dispatch with payload', async () => {
      const result = await Effect.gen(function* () {
        const tui = yield* TestApp.run()
        tui.dispatch({ _tag: 'Start' })
        tui.dispatch({ _tag: 'Increment' })
        tui.dispatch({ _tag: 'Finish', total: 42 })
        return tui.getState()
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('final-visual')), Effect.runPromise)

      expect(result).toEqual({ _tag: 'Complete', total: 42 })
    })
  })

  describe('final-json mode', () => {
    test('outputs JSON on scope close', async () => {
      await Effect.gen(function* () {
        const tui = yield* TestApp.run()
        tui.dispatch({ _tag: 'Start' })
        tui.dispatch({ _tag: 'Increment' })
        tui.dispatch({ _tag: 'Finish', total: 10 })
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('final-json')), Effect.runPromise)

      expect(capturedOutput).toHaveLength(1)
      const parsed = JSON.parse(capturedOutput[0]!)
      expect(parsed).toEqual({ _tag: 'Complete', total: 10 })
    })

    test('outputs final state even if only initial', async () => {
      await Effect.gen(function* () {
        yield* TestApp.run()
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('final-json')), Effect.runPromise)

      expect(capturedOutput).toHaveLength(1)
      const parsed = JSON.parse(capturedOutput[0]!)
      expect(parsed).toEqual({ _tag: 'Idle' })
    })
  })

  describe('progressive-json mode', () => {
    test('outputs NDJSON for each state change', async () => {
      await Effect.gen(function* () {
        const tui = yield* TestApp.run()
        // Small delay to allow stream to process
        yield* Effect.sleep('10 millis')
        tui.dispatch({ _tag: 'Start' })
        yield* Effect.sleep('10 millis')
        tui.dispatch({ _tag: 'Finish', total: 10 })
        yield* Effect.sleep('10 millis')
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('progressive-json')), Effect.runPromise)

      // Should have multiple JSON lines
      expect(capturedOutput.length).toBeGreaterThanOrEqual(1)

      // Each line should be valid JSON
      for (const line of capturedOutput) {
        expect(() => JSON.parse(line)).not.toThrow()
      }

      // Last output should be Complete state
      if (capturedOutput.length > 0) {
        const lastParsed = JSON.parse(capturedOutput[capturedOutput.length - 1]!)
        expect(lastParsed._tag).toBe('Complete')
      }
    })
  })

  describe('final-visual mode', () => {
    test('does not output anything', async () => {
      await Effect.gen(function* () {
        const tui = yield* TestApp.run()
        tui.dispatch({ _tag: 'Start' })
        tui.dispatch({ _tag: 'Finish', total: 10 })
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('final-visual')), Effect.runPromise)

      expect(capturedOutput).toHaveLength(0)
    })
  })

  describe('stateRef access', () => {
    test('stateRef can be used with SubscriptionRef operations', async () => {
      const states: TestState[] = []

      await Effect.gen(function* () {
        const tui = yield* TestApp.run()

        // Manually subscribe to changes
        const current = yield* SubscriptionRef.get(tui.stateRef)
        states.push(current)

        tui.dispatch({ _tag: 'Start' })
        const updated = yield* SubscriptionRef.get(tui.stateRef)
        states.push(updated)
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('final-visual')), Effect.runPromise)

      expect(states).toEqual([{ _tag: 'Idle' }, { _tag: 'Running', count: 0 }])
    })
  })
})

describe('createTestTuiState', () => {
  test('captures all state changes', async () => {
    const result = await Effect.gen(function* () {
      const { api, getStates, getFinalState } = yield* createTestTuiState({
        stateSchema: TestState,
        actionSchema: TestAction,
        initial: { _tag: 'Idle' } as TestState,
        reducer: testReducer,
      })

      api.dispatch({ _tag: 'Start' })
      api.dispatch({ _tag: 'Increment' })
      api.dispatch({ _tag: 'Increment' })
      api.dispatch({ _tag: 'Finish', total: 5 })

      // Small delay to allow stream to process
      yield* Effect.sleep('10 millis')

      return {
        states: getStates(),
        final: getFinalState(),
      }
    }).pipe(Effect.scoped, Effect.runPromise)

    expect(result.states).toHaveLength(5) // initial + 4 dispatches
    expect(result.states[0]).toEqual({ _tag: 'Idle' })
    expect(result.states[4]).toEqual({ _tag: 'Complete', total: 5 })
    expect(result.final).toEqual({ _tag: 'Complete', total: 5 })
  })
})
