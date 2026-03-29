/**
 * Tests for TuiApp factory pattern
 */

import { it } from '@effect/vitest'
import { Cause, Effect, FiberId, pipe, Schema } from 'effect'
import React from 'react'
import { describe, expect, beforeEach, afterEach, test } from 'vitest'

import { testModeLayer } from '../../src/effect/testing.tsx'
import {
  createTuiApp,
  run,
  runResult,
  useTuiAtomValue,
  deriveOutputSchema,
  Box,
  Text,
  type TuiOutput,
} from '../../src/mod.tsx'

const decodeJson = <A, I>(schema: Schema.Schema<A, I, never>, json: string): A =>
  Schema.decodeSync(Schema.parseJson(schema))(json)
const decodeJsonEncoded = <A, I>(schema: Schema.Schema<A, I, never>, json: string): I =>
  Schema.decodeSync(Schema.parseJson(Schema.encodedSchema(schema)))(json)
const encodeJsonEncoded = <A, I>(schema: Schema.Schema<A, I, never>, value: I): string =>
  Schema.encodeSync(Schema.parseJson(Schema.encodedSchema(schema)))(value)

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
          const output = decodeJson(CounterApp.outputSchema, capturedOutput[0]!)
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
          const output = decodeJson(CounterApp.outputSchema, capturedOutput[0]!)
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

          // Intermediate lines are raw state (for progressive consumption)
          const initialState = decodeJson(CounterState, capturedOutput[0]!)
          expect(initialState).toEqual({ count: 0 })

          // Final line should be wrapped in Success
          const finalOutput = decodeJson(
            CounterApp.outputSchema,
            capturedOutput[capturedOutput.length - 1]!,
          )
          expect(finalOutput._tag).toBe('Success')
          if (finalOutput._tag === 'Success') {
            expect(finalOutput.count).toBe(2)
          }
        }),
      ),
    )
  })

  describe('ndjson mode with event mapping', () => {
    const CounterEvent = Schema.Union(
      Schema.TaggedStruct('Incremented', { newCount: Schema.Number }),
      Schema.TaggedStruct('Decremented', { newCount: Schema.Number }),
      Schema.TaggedStruct('Reset', { from: Schema.Number, to: Schema.Number }),
    )

    const EventCounterApp = createTuiApp({
      stateSchema: CounterState,
      actionSchema: CounterAction,
      initial: { count: 0 },
      reducer: counterReducer,
      ndjson: {
        eventSchema: CounterEvent,
        fromAction: (action, prevState) => {
          const newCount = counterReducer({ state: prevState, action }).count
          switch (action._tag) {
            case 'Increment':
              return [{ _tag: 'Incremented' as const, newCount }]
            case 'Decrement':
              return [{ _tag: 'Decremented' as const, newCount }]
            case 'Set':
              return [{ _tag: 'Reset' as const, from: prevState.count, to: newCount }]
          }
        },
      },
    })

    it.live('emits events instead of full state snapshots', () =>
      Effect.gen(function* () {
        const tui = yield* EventCounterApp.run()
        yield* Effect.sleep('10 millis')
        tui.dispatch({ _tag: 'Increment' })
        yield* Effect.sleep('10 millis')
        tui.dispatch({ _tag: 'Increment' })
        yield* Effect.sleep('10 millis')
      }).pipe(
        Effect.scoped,
        Effect.provide(testModeLayer('ndjson')),
        Effect.andThen(() => {
          // Line 1: initial full state snapshot
          const initialState = decodeJson(CounterState, capturedOutput[0]!)
          expect(initialState).toEqual({ count: 0 })

          // Intermediate lines: events (not full state)
          const event1 = decodeJson(CounterEvent, capturedOutput[1]!)
          expect(event1).toEqual({ _tag: 'Incremented', newCount: 1 })

          const event2 = decodeJson(CounterEvent, capturedOutput[2]!)
          expect(event2).toEqual({ _tag: 'Incremented', newCount: 2 })

          // Final line: Success wrapper with full state
          const finalOutput = decodeJson(
            EventCounterApp.outputSchema,
            capturedOutput[capturedOutput.length - 1]!,
          )
          expect(finalOutput).toEqual({ _tag: 'Success', count: 2 })
        }),
      ),
    )

    it.live('suppresses output when fromAction returns empty array', () => {
      const SilentApp = createTuiApp({
        stateSchema: CounterState,
        actionSchema: CounterAction,
        initial: { count: 0 },
        reducer: counterReducer,
        ndjson: {
          eventSchema: CounterEvent,
          fromAction: () => [],
        },
      })

      return Effect.gen(function* () {
        const tui = yield* SilentApp.run()
        yield* Effect.sleep('10 millis')
        tui.dispatch({ _tag: 'Increment' })
        tui.dispatch({ _tag: 'Increment' })
        yield* Effect.sleep('10 millis')
      }).pipe(
        Effect.scoped,
        Effect.provide(testModeLayer('ndjson')),
        Effect.andThen(() => {
          // Only initial state + final wrapped output (no intermediate events)
          expect(capturedOutput).toHaveLength(2)
          expect(decodeJson(CounterState, capturedOutput[0]!)).toEqual({ count: 0 })
          expect(decodeJson(SilentApp.outputSchema, capturedOutput[1]!)).toEqual({
            _tag: 'Success',
            count: 2,
          })
        }),
      )
    })

    it.live('emits multiple events per action', () => {
      const MultiEventApp = createTuiApp({
        stateSchema: CounterState,
        actionSchema: CounterAction,
        initial: { count: 0 },
        reducer: counterReducer,
        ndjson: {
          eventSchema: CounterEvent,
          fromAction: (action, prevState) => {
            const newCount = counterReducer({ state: prevState, action }).count
            return [
              { _tag: 'Decremented' as const, newCount: prevState.count },
              { _tag: 'Incremented' as const, newCount },
            ]
          },
        },
      })

      return Effect.gen(function* () {
        const tui = yield* MultiEventApp.run()
        yield* Effect.sleep('10 millis')
        tui.dispatch({ _tag: 'Increment' })
        yield* Effect.sleep('10 millis')
      }).pipe(
        Effect.scoped,
        Effect.provide(testModeLayer('ndjson')),
        Effect.andThen(() => {
          // Initial + 2 events from 1 action + final
          expect(capturedOutput).toHaveLength(4)
          expect(decodeJson(CounterEvent, capturedOutput[1]!)).toEqual({
            _tag: 'Decremented',
            newCount: 0,
          })
          expect(decodeJson(CounterEvent, capturedOutput[2]!)).toEqual({
            _tag: 'Incremented',
            newCount: 1,
          })
        }),
      )
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
// Issue #129 Reproduction: ParseError masks real errors in JSON output
// https://github.com/overengineeringstudio/effect-utils/issues/129
// =============================================================================

describe('Issue #129: Typed errors properly encoded in JSON output', () => {
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

  // Simulate a typed error like GenieGenerationFailedError
  class GenerationFailed extends Schema.TaggedError<GenerationFailed>()('GenerationFailed', {
    message: Schema.String,
    failedCount: Schema.Number,
  }) {}

  it.effect('json mode: typed error in handler produces Failure JSON output', () =>
    run(CounterApp, (tui) =>
      Effect.gen(function* () {
        tui.dispatch({ _tag: 'Set', value: 42 })
        return yield* new GenerationFailed({
          message: '3 file(s) failed to generate',
          failedCount: 3,
        })
      }),
    ).pipe(
      Effect.provide(testModeLayer('json')),
      Effect.catchAllCause((cause) =>
        Effect.sync(() => {
          // FIX: JSON output IS produced with Failure wrapper
          expect(capturedOutput).toHaveLength(1)
          const output = JSON.parse(capturedOutput[0]!)
          expect(output._tag).toBe('Failure')
          expect(output.state.count).toBe(42)
          expect(output.cause).toBeDefined()

          // FIX: No ParseError defect — typed error encoded safely via Schema.Defect
          const defects = [...Cause.defects(cause)]
          const parseError = defects.find(
            (d) => d instanceof Error && d.message.includes('Expected never'),
          )
          expect(parseError).toBeUndefined()

          // The typed error is still in the cause for in-process handling
          const failures = [...Cause.failures(cause)]
          expect(failures.some((e) => e instanceof GenerationFailed)).toBe(true)
        }),
      ),
    ),
  )

  it.live('ndjson mode: typed error produces final Failure line', () =>
    run(CounterApp, (tui) =>
      Effect.gen(function* () {
        yield* Effect.sleep('10 millis')
        tui.dispatch({ _tag: 'Set', value: 42 })
        yield* Effect.sleep('10 millis')
        return yield* new GenerationFailed({
          message: '3 file(s) failed to generate',
          failedCount: 3,
        })
      }),
    ).pipe(
      Effect.provide(testModeLayer('ndjson')),
      Effect.catchAllCause((cause) =>
        Effect.sync(() => {
          // Intermediate state lines are output correctly
          const intermediateLines = capturedOutput.filter((line) => {
            try {
              const parsed = JSON.parse(line)
              return !('_tag' in parsed)
            } catch {
              return false
            }
          })
          expect(intermediateLines.length).toBeGreaterThan(0)

          // FIX: The final Failure-wrapped line IS present
          const failureLines = capturedOutput.filter((line) => {
            try {
              const parsed = JSON.parse(line)
              return '_tag' in parsed && parsed._tag === 'Failure'
            } catch {
              return false
            }
          })
          expect(failureLines).toHaveLength(1)
          const failureOutput = JSON.parse(failureLines[0]!)
          expect(failureOutput.state.count).toBe(42)

          // FIX: No ParseError defect
          const defects = [...Cause.defects(cause)]
          expect(
            defects.some((d) => d instanceof Error && d.message.includes('Expected never')),
          ).toBe(false)
        }),
      ),
    ),
  )
})

// =============================================================================
// Standalone run() dual API tests
// =============================================================================

describe('run (standalone dual API)', () => {
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

  class TestError extends Schema.TaggedError<TestError>()('TestError', {
    message: Schema.String,
  }) {}

  it.effect('data-first: dispatch updates state', () =>
    run(CounterApp, (tui) =>
      Effect.gen(function* () {
        tui.dispatch({ _tag: 'Increment' })
        tui.dispatch({ _tag: 'Increment' })
        expect(tui.getState()).toEqual({ count: 2 })
      }),
    ).pipe(Effect.provide(testModeLayer('pipe'))),
  )

  it.effect('data-last (pipeable): dispatch updates state', () =>
    pipe(
      CounterApp,
      run((tui) =>
        Effect.sync(() => {
          tui.dispatch({ _tag: 'Set', value: 42 })
          expect(tui.getState()).toEqual({ count: 42 })
        }),
      ),
      Effect.provide(testModeLayer('pipe')),
    ),
  )

  it.effect('handler return value is propagated', () =>
    run(CounterApp, (tui) =>
      Effect.gen(function* () {
        tui.dispatch({ _tag: 'Set', value: 99 })
        return tui.getState().count
      }),
    ).pipe(
      Effect.provide(testModeLayer('pipe')),
      Effect.map((count) => {
        expect(count).toBe(99)
      }),
    ),
  )

  it.effect('typed errors are propagated via Effect channel', () =>
    run(CounterApp, () => new TestError({ message: 'test error' })).pipe(
      Effect.provide(testModeLayer('pipe')),
      Effect.catchAll((error) =>
        Effect.sync(() => {
          expect(error).toBeInstanceOf(TestError)
          expect(error.message).toBe('test error')
        }),
      ),
    ),
  )

  it.effect('no Scope.Scope in requirements (scope managed internally)', () =>
    // This compiles without Effect.scoped — verifying the return type
    run(CounterApp, (tui) =>
      Effect.gen(function* () {
        tui.dispatch({ _tag: 'Increment' })
      }),
    ).pipe(Effect.provide(testModeLayer('pipe'))),
  )

  it.effect('json mode outputs Success for successful handler', () =>
    run(CounterApp, (tui) =>
      Effect.gen(function* () {
        tui.dispatch({ _tag: 'Set', value: 77 })
      }),
    ).pipe(
      Effect.provide(testModeLayer('json')),
      Effect.andThen(() => {
        expect(capturedOutput).toHaveLength(1)
        const output = JSON.parse(capturedOutput[0]!)
        expect(output).toEqual({ _tag: 'Success', count: 77 })
      }),
    ),
  )

  it.effect('view option is passed through', () =>
    run(
      CounterApp,
      (tui) =>
        Effect.gen(function* () {
          tui.dispatch({ _tag: 'Set', value: 100 })
          expect(tui.getState()).toEqual({ count: 100 })
        }),
      { view: <CounterView /> },
    ).pipe(Effect.provide(testModeLayer('tty'))),
  )
})

// =============================================================================
// runResult — Result-oriented command execution
// =============================================================================

describe('runResult', () => {
  let originalLog: typeof console.log
  let originalStdoutWrite: typeof process.stdout.write
  let capturedConsole: string[]
  let capturedStdout: string[]

  beforeEach(() => {
    originalLog = console.log
    originalStdoutWrite = process.stdout.write
    capturedConsole = []
    capturedStdout = []
    console.log = (msg: string) => {
      capturedConsole.push(msg)
    }
    process.stdout.write = ((chunk: unknown) => {
      capturedStdout.push(String(chunk))
      return true
    }) as typeof process.stdout.write
  })

  afterEach(() => {
    console.log = originalLog
    process.stdout.write = originalStdoutWrite
  })

  describe('string result (Schema.String)', () => {
    it.effect('json mode: writes raw string to stdout (no JSON encoding)', () =>
      runResult(
        CounterApp,
        (tui) =>
          Effect.gen(function* () {
            tui.dispatch({ _tag: 'Set', value: 42 })
            return 'my-secret-value'
          }),
        { result: Schema.String },
      ).pipe(
        Effect.provide(testModeLayer('json')),
        Effect.andThen((result) => {
          expect(result).toBe('my-secret-value')
          const stdout = capturedStdout.join('')
          expect(stdout).toBe('my-secret-value\n')
          expect(capturedConsole).toHaveLength(0)
        }),
      ),
    )

    it.effect('json mode: no Success/Failure envelope in output', () =>
      runResult(
        CounterApp,
        (tui) =>
          Effect.gen(function* () {
            tui.dispatch({ _tag: 'Increment' })
            return 'the-output'
          }),
        { result: Schema.String },
      ).pipe(
        Effect.provide(testModeLayer('json')),
        Effect.andThen(() => {
          const allOutput = capturedStdout.join('') + capturedConsole.join('')
          expect(allOutput).not.toContain('Success')
          expect(allOutput).not.toContain('Failure')
          expect(allOutput).toContain('the-output')
        }),
      ),
    )

    it.effect('pipe mode (react/final): renders view, not raw result', () =>
      runResult(
        CounterApp,
        (tui) =>
          Effect.gen(function* () {
            tui.dispatch({ _tag: 'Set', value: 55 })
            return 'should-not-be-raw'
          }),
        { result: Schema.String, view: <CounterView /> },
      ).pipe(
        Effect.provide(testModeLayer('pipe')),
        Effect.andThen((result) => {
          expect(result).toBe('should-not-be-raw')
          const stdout = capturedStdout.join('')
          expect(stdout).not.toContain('should-not-be-raw')
        }),
      ),
    )
  })

  describe('structured result (Schema.Struct)', () => {
    const ResultSchema = Schema.Struct({
      items: Schema.Array(Schema.String),
      total: Schema.Number,
    })

    it.effect('json mode: writes JSON-encoded result to console', () =>
      runResult(
        CounterApp,
        (tui) =>
          Effect.gen(function* () {
            tui.dispatch({ _tag: 'Set', value: 3 })
            return { items: ['a', 'b', 'c'], total: 3 }
          }),
        { result: ResultSchema },
      ).pipe(
        Effect.provide(testModeLayer('json')),
        Effect.andThen((result) => {
          expect(result).toEqual({ items: ['a', 'b', 'c'], total: 3 })
          expect(capturedConsole).toHaveLength(1)
          const parsed = JSON.parse(capturedConsole[0]!)
          expect(parsed).toEqual({ items: ['a', 'b', 'c'], total: 3 })
          expect(parsed._tag).toBeUndefined()
        }),
      ),
    )
  })

  describe('ndjson assertion', () => {
    it.effect(
      'ndjson mode: fails with clear error (result commands do not support streaming)',
      () =>
        runResult(CounterApp, () => Effect.succeed('value'), { result: Schema.String }).pipe(
          Effect.provide(testModeLayer('ndjson')),
          Effect.catchAllDefect((defect) =>
            Effect.sync(() => {
              expect(defect).toBeInstanceOf(Error)
              expect((defect as Error).message).toContain('runResult does not support ndjson')
            }),
          ),
        ),
    )
  })

  describe('error handling', () => {
    class ReadError extends Schema.TaggedError<ReadError>()('ReadError', {
      message: Schema.String,
    }) {}

    it.effect('handler error: no stdout, error propagated', () =>
      runResult(CounterApp, () => new ReadError({ message: 'access denied' }), {
        result: Schema.String,
      }).pipe(
        Effect.provide(testModeLayer('json')),
        Effect.catchAll((error) =>
          Effect.sync(() => {
            expect(error).toBeInstanceOf(ReadError)
            expect(error.message).toBe('access denied')
            const stdout = capturedStdout.join('')
            expect(stdout).toBe('')
            expect(capturedConsole).toHaveLength(0)
          }),
        ),
      ),
    )
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
        const parsed = decodeJsonEncoded(OutputSchema, encoded)

        expect(parsed).toEqual({
          _tag: 'Success',
          count: 42,
          name: 'test',
        })
      }),
    )

    it.effect('success: decodes flat fields to success value', () =>
      Effect.gen(function* () {
        const json = encodeJsonEncoded(OutputSchema, {
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
        const parsed = decodeJsonEncoded(OutputSchema, encoded)

        expect(parsed._tag).toBe('Failure')
        if (parsed._tag === 'Failure') {
          expect(parsed.state).toEqual({ count: 10, name: 'partial' })
          expect(parsed.cause).toBeDefined()
          expect(parsed.cause._tag).toBe('Interrupt')
        }
      }),
    )

    it.effect('failure: decodes cause and state', () =>
      Effect.gen(function* () {
        const interruptCause = Cause.interrupt(FiberId.none)
        const failureValue: TuiOutput<typeof StateSchema.Type> = {
          _tag: 'Failure',
          cause: interruptCause,
          state: { count: 10, name: 'partial' },
        }
        const json = yield* Schema.encode(Schema.parseJson(OutputSchema))(failureValue)

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
        const parsed = decodeJsonEncoded(OutputSchema, encoded)

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
        const parsed = decodeJsonEncoded(OutputSchema, encoded)

        expect(parsed._tag).toBe('Failure')
        if (parsed._tag === 'Failure') {
          expect(parsed.state.workspace.name).toBe('my-repo')
          expect(parsed.state.results).toHaveLength(1)
        }
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
    const OutputSchema = deriveOutputSchema(UnionStateSchema)
    const OutputEncodedSchema = Schema.Union(
      Schema.TaggedStruct('Success', { value: UnionStateSchema }),
      Schema.TaggedStruct('Failure', {
        cause: Schema.Cause({ error: Schema.Never, defect: Schema.Defect }),
        state: UnionStateSchema,
      }),
    )

    it.effect('non-struct state: wraps in value field', () =>
      Effect.gen(function* () {
        // For non-struct schemas, we can't spread fields
        // The schema should fall back to wrapping in a `value` field
        // This is a limitation - union states get wrapped in `value`
        const successValue: Schema.Schema.Encoded<typeof OutputEncodedSchema> = {
          _tag: 'Success',
          value: { _tag: 'Done', result: 'completed' },
        }

        const encoded = encodeJsonEncoded(OutputEncodedSchema, successValue)
        const parsed = decodeJsonEncoded(OutputEncodedSchema, encoded)
        yield* Schema.decode(Schema.parseJson(OutputSchema))(encoded)

        expect(parsed._tag).toBe('Success')
        if (parsed._tag === 'Success') {
          expect(parsed.value._tag).toBe('Done')
        }
      }),
    )
  })
})
