/**
 * Counter Example - Effect integration with createTuiApp
 *
 * Demonstrates:
 * - createTuiApp factory pattern
 * - State and Action schemas with Effect Schema
 * - Reducer pattern for state updates
 * - App-scoped hooks (CounterApp.useState, CounterApp.useDispatch)
 * - Sync dispatch (no yield* needed)
 * - Output mode support (--json flag)
 * - Graceful Ctrl+C handling with Interrupted state
 *
 * Run:
 *   bun examples/03-effect-integration/counter.tsx
 *   bun examples/03-effect-integration/counter.tsx --json
 *   bun examples/03-effect-integration/counter.tsx --help
 */

import { Command } from '@effect/cli'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Duration, Effect, Schema } from 'effect'
import React from 'react'

import {
  createTuiApp,
  Box,
  Text,
  Spinner,
  outputModeOptions,
  outputModeLayerFromFlagsWithTTY,
} from '../../src/mod.ts'

// =============================================================================
// State Schema
// =============================================================================

const RunningState = Schema.Struct({
  _tag: Schema.Literal('Running'),
  count: Schema.Number,
  status: Schema.Literal('idle', 'loading'),
  history: Schema.Array(Schema.String),
})

const CompleteState = Schema.Struct({
  _tag: Schema.Literal('Complete'),
  finalCount: Schema.Number,
  history: Schema.Array(Schema.String),
})

const InterruptedState = Schema.Struct({
  _tag: Schema.Literal('Interrupted'),
  count: Schema.Number,
  history: Schema.Array(Schema.String),
})

const CounterState = Schema.Union(RunningState, CompleteState, InterruptedState)

type CounterState = typeof CounterState.Type

// =============================================================================
// Action Schema
// =============================================================================

const CounterAction = Schema.Union(
  Schema.TaggedStruct('Increment', {}),
  Schema.TaggedStruct('Decrement', {}),
  Schema.TaggedStruct('SetLoading', {}),
  Schema.TaggedStruct('SetComplete', { message: Schema.String }),
  Schema.TaggedStruct('Interrupted', {}),
)

type CounterAction = typeof CounterAction.Type

// =============================================================================
// Reducer
// =============================================================================

const timestamp = () => new Date().toISOString().slice(11, 19)

const counterReducer = ({
  state,
  action,
}: {
  state: CounterState
  action: CounterAction
}): CounterState => {
  const addHistory = (entry: string) => {
    const history = state._tag === 'Running' ? state.history : []
    return [...history.slice(-4), `[${timestamp()}] ${entry}`]
  }

  switch (action._tag) {
    case 'Increment': {
      if (state._tag !== 'Running') return state
      return {
        ...state,
        count: state.count + 1,
        status: 'idle',
        history: addHistory(`Incremented to ${state.count + 1}`),
      }
    }
    case 'Decrement': {
      if (state._tag !== 'Running') return state
      return {
        ...state,
        count: state.count - 1,
        status: 'idle',
        history: addHistory(`Decremented to ${state.count - 1}`),
      }
    }
    case 'SetLoading': {
      if (state._tag !== 'Running') return state
      return { ...state, status: 'loading' }
    }
    case 'SetComplete': {
      if (state._tag !== 'Running') return state
      return {
        _tag: 'Complete',
        finalCount: state.count,
        history: addHistory(action.message),
      }
    }
    case 'Interrupted': {
      if (state._tag !== 'Running') return state
      return {
        _tag: 'Interrupted',
        count: state.count,
        history: addHistory('Interrupted by user'),
      }
    }
  }
}

// =============================================================================
// View Components
// =============================================================================

const RunningView = ({ state }: { state: Extract<CounterState, { _tag: 'Running' }> }) => (
  <Box flexDirection="column" padding={1}>
    <Text bold color="cyan">
      Counter Example
    </Text>

    <Box marginTop={1} flexDirection="row">
      {state.status === 'loading' ? (
        <>
          <Spinner color="yellow" />
          <Text> Processing...</Text>
        </>
      ) : (
        <>
          <Text>Count: </Text>
          <Text color={state.count >= 0 ? 'green' : 'red'} bold>
            {state.count}
          </Text>
        </>
      )}
    </Box>

    {state.history.length > 0 && (
      <Box marginTop={1} flexDirection="column">
        <Text dim>History:</Text>
        {state.history.map((entry, i) => (
          <Text key={i} dim>
            {'  '}
            {entry}
          </Text>
        ))}
      </Box>
    )}
  </Box>
)

const CompleteView = ({ state }: { state: Extract<CounterState, { _tag: 'Complete' }> }) => (
  <Box flexDirection="column" padding={1}>
    <Text bold color="green">
      Counter Example - Complete
    </Text>

    <Box marginTop={1} flexDirection="row">
      <Text>Final Count: </Text>
      <Text color={state.finalCount >= 0 ? 'green' : 'red'} bold>
        {state.finalCount}
      </Text>
    </Box>

    {state.history.length > 0 && (
      <Box marginTop={1} flexDirection="column">
        <Text dim>History:</Text>
        {state.history.map((entry, i) => (
          <Text key={i} dim>
            {'  '}
            {entry}
          </Text>
        ))}
      </Box>
    )}
  </Box>
)

const InterruptedView = ({ state }: { state: Extract<CounterState, { _tag: 'Interrupted' }> }) => (
  <Box flexDirection="column" padding={1}>
    <Text bold color="yellow">
      Counter Example - Interrupted
    </Text>

    <Box marginTop={1} flexDirection="row">
      <Text>Count at interruption: </Text>
      <Text bold>{state.count}</Text>
    </Box>

    {state.history.length > 0 && (
      <Box marginTop={1} flexDirection="column">
        <Text dim>History:</Text>
        {state.history.map((entry, i) => (
          <Text key={i} dim>
            {'  '}
            {entry}
          </Text>
        ))}
      </Box>
    )}
  </Box>
)

// =============================================================================
// Main Program
// =============================================================================

const runCounter = Effect.gen(function* () {
  const CounterApp = createTuiApp({
    stateSchema: CounterState,
    actionSchema: CounterAction,
    initial: {
      _tag: 'Running',
      count: 0,
      status: 'idle',
      history: [],
    } as CounterState,
    reducer: counterReducer,
    interruptTimeout: 200,
  })

  const CounterView = () => {
    const state = CounterApp.useState()
    switch (state._tag) {
      case 'Running':
        return <RunningView state={state} />
      case 'Complete':
        return <CompleteView state={state} />
      case 'Interrupted':
        return <InterruptedView state={state} />
    }
  }

  const tui = yield* CounterApp.run(<CounterView />)

  // Increment a few times
  for (let i = 0; i < 3; i++) {
    if (tui.getState()._tag !== 'Running') break
    tui.dispatch({ _tag: 'Increment' })
    yield* Effect.sleep(Duration.millis(400))
  }

  // Show loading state
  if (tui.getState()._tag === 'Running') {
    tui.dispatch({ _tag: 'SetLoading' })
    yield* Effect.sleep(Duration.millis(800))
  }

  // Decrement once
  if (tui.getState()._tag === 'Running') {
    tui.dispatch({ _tag: 'Decrement' })
    yield* Effect.sleep(Duration.millis(400))
  }

  // Complete
  if (tui.getState()._tag === 'Running') {
    const state = tui.getState() as Extract<CounterState, { _tag: 'Running' }>
    tui.dispatch({ _tag: 'SetComplete', message: `Final count: ${state.count}` })
  }

  return { finalCount: (tui.getState() as any).finalCount ?? (tui.getState() as any).count }
}).pipe(Effect.scoped)

// =============================================================================
// CLI Command
// =============================================================================

const counter = Command.make('counter', outputModeOptions, ({ json, stream, visual }) =>
  runCounter.pipe(Effect.provide(outputModeLayerFromFlagsWithTTY({ json, stream, visual }))),
)

const cli = Command.run(counter, {
  name: 'counter',
  version: '1.0.0',
})

// Run with Effect CLI (handles SIGINT/SIGTERM properly)
cli(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain)
