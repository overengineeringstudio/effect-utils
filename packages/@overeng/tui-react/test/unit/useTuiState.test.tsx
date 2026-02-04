/**
 * Tests for TuiApp (createTuiApp pattern)
 */

import { it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { describe, expect, beforeEach, afterEach } from 'vitest'

import { createTestTuiState, testModeLayer } from '../../src/effect/testing.tsx'
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

const testReducer = ({ state, action }: { state: TestState; action: TestAction }): TestState => {
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
    it.effect('initializes with provided initial state', () =>
      Effect.gen(function* () {
        const tui = yield* TestApp.run()
        const result = tui.getState()
        expect(result).toEqual({ _tag: 'Idle' })
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('pipe'))),
    )

    it.effect('dispatch updates state via reducer', () =>
      Effect.gen(function* () {
        const tui = yield* TestApp.run()
        tui.dispatch({ _tag: 'Start' })
        const result = tui.getState()
        expect(result).toEqual({ _tag: 'Running', count: 0 })
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('pipe'))),
    )

    it.effect('multiple dispatches apply reducer sequentially', () =>
      Effect.gen(function* () {
        const tui = yield* TestApp.run()
        tui.dispatch({ _tag: 'Start' })
        tui.dispatch({ _tag: 'Increment' })
        tui.dispatch({ _tag: 'Increment' })
        tui.dispatch({ _tag: 'Increment' })
        const result = tui.getState()
        expect(result).toEqual({ _tag: 'Running', count: 3 })
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('pipe'))),
    )

    it.effect('dispatch with payload', () =>
      Effect.gen(function* () {
        const tui = yield* TestApp.run()
        tui.dispatch({ _tag: 'Start' })
        tui.dispatch({ _tag: 'Increment' })
        tui.dispatch({ _tag: 'Finish', total: 42 })
        const result = tui.getState()
        expect(result).toEqual({ _tag: 'Complete', total: 42 })
      }).pipe(Effect.scoped, Effect.provide(testModeLayer('pipe'))),
    )
  })

  describe('json mode', () => {
    it.effect('outputs JSON on scope close with Success wrapper', () =>
      Effect.gen(function* () {
        const tui = yield* TestApp.run()
        tui.dispatch({ _tag: 'Start' })
        tui.dispatch({ _tag: 'Increment' })
        tui.dispatch({ _tag: 'Finish', total: 10 })
      }).pipe(
        Effect.scoped,
        Effect.provide(testModeLayer('json')),
        Effect.andThen(() => {
          expect(capturedOutput).toHaveLength(1)
          const parsed = JSON.parse(capturedOutput[0]!)
          // State is a union (non-struct), so it's wrapped in `value`
          expect(parsed._tag).toBe('Success')
          expect(parsed.value).toEqual({ _tag: 'Complete', total: 10 })
        }),
      ),
    )

    it.effect('outputs final state even if only initial', () =>
      TestApp.run().pipe(
        Effect.scoped,
        Effect.provide(testModeLayer('json')),
        Effect.andThen(() => {
          expect(capturedOutput).toHaveLength(1)
          const parsed = JSON.parse(capturedOutput[0]!)
          // State is a union (non-struct), so it's wrapped in `value`
          expect(parsed._tag).toBe('Success')
          expect(parsed.value).toEqual({ _tag: 'Idle' })
        }),
      ),
    )
  })

  describe('ndjson mode', () => {
    it.live('outputs NDJSON with final Success wrapper', () =>
      Effect.gen(function* () {
        const tui = yield* TestApp.run()
        // Small delay to allow stream to process
        yield* Effect.sleep('10 millis')
        tui.dispatch({ _tag: 'Start' })
        yield* Effect.sleep('10 millis')
        tui.dispatch({ _tag: 'Finish', total: 10 })
        yield* Effect.sleep('10 millis')
      }).pipe(
        Effect.scoped,
        Effect.provide(testModeLayer('ndjson')),
        Effect.andThen(() => {
          // Should have multiple JSON lines (intermediate raw + final wrapped)
          expect(capturedOutput.length).toBeGreaterThanOrEqual(2)

          // Each line should be valid JSON
          for (const line of capturedOutput) {
            expect(() => JSON.parse(line)).not.toThrow()
          }

          // First output should be raw state (Idle)
          const firstParsed = JSON.parse(capturedOutput[0]!)
          expect(firstParsed._tag).toBe('Idle')

          // Last output should be Success wrapper with Complete state
          const lastParsed = JSON.parse(capturedOutput[capturedOutput.length - 1]!)
          expect(lastParsed._tag).toBe('Success')
          expect(lastParsed.value._tag).toBe('Complete')
        }),
      ),
    )
  })

  describe('pipe mode', () => {
    it.effect('does not output anything', () =>
      Effect.gen(function* () {
        const tui = yield* TestApp.run()
        tui.dispatch({ _tag: 'Start' })
        tui.dispatch({ _tag: 'Finish', total: 10 })
      }).pipe(
        Effect.scoped,
        Effect.provide(testModeLayer('pipe')),
        Effect.andThen(() => {
          expect(capturedOutput).toHaveLength(0)
        }),
      ),
    )
  })

  describe('stateAtom access', () => {
    it.effect('stateAtom can be used with getState()', () => {
      const states: TestState[] = []

      return Effect.gen(function* () {
        const tui = yield* TestApp.run()

        // Get current state
        const current = tui.getState()
        states.push(current)

        tui.dispatch({ _tag: 'Start' })
        const updated = tui.getState()
        states.push(updated)
      }).pipe(
        Effect.scoped,
        Effect.provide(testModeLayer('pipe')),
        Effect.andThen(() => {
          expect(states).toEqual([{ _tag: 'Idle' }, { _tag: 'Running', count: 0 }])
        }),
      )
    })
  })
})

describe('createTestTuiState', () => {
  it.live('captures all state changes', () =>
    Effect.gen(function* () {
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

      const states = getStates()
      const final = getFinalState()

      expect(states).toHaveLength(5) // initial + 4 dispatches
      expect(states[0]).toEqual({ _tag: 'Idle' })
      expect(states[4]).toEqual({ _tag: 'Complete', total: 5 })
      expect(final).toEqual({ _tag: 'Complete', total: 5 })
    }).pipe(Effect.scoped),
  )
})
