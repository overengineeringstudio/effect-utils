/**
 * Hello World - The simplest possible tui-react example.
 *
 * Demonstrates:
 * - Effect CLI integration for proper signal handling
 * - createTuiApp pattern (even for simple apps)
 * - Using Box and Text components
 * - Basic styling (colors, bold)
 * - Graceful Ctrl+C handling
 *
 * Run:
 *   bun examples/01-basic/hello-world.tsx
 *   bun examples/01-basic/hello-world.tsx --json
 *   bun examples/01-basic/hello-world.tsx --help
 */

import { Command, Options } from '@effect/cli'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Effect, Schema } from 'effect'
import React from 'react'

import {
  createTuiApp,
  Box,
  Text,
  outputModeOptions,
  outputModeLayerFromFlagsWithTTY,
} from '../../src/mod.ts'

// =============================================================================
// CLI Options
// =============================================================================

const durationOption = Options.integer('duration').pipe(
  Options.withAlias('d'),
  Options.withDescription('Duration in seconds before auto-exit'),
  Options.withDefault(3),
)

// =============================================================================
// State Schema
// =============================================================================

const DisplayingState = Schema.Struct({
  _tag: Schema.Literal('Displaying'),
  secondsRemaining: Schema.Number,
})

const FinishedState = Schema.Struct({
  _tag: Schema.Literal('Finished'),
  message: Schema.String,
})

const InterruptedState = Schema.Struct({
  _tag: Schema.Literal('Interrupted'),
})

const AppState = Schema.Union(DisplayingState, FinishedState, InterruptedState)

type AppState = Schema.Schema.Type<typeof AppState>

// =============================================================================
// Action Schema
// =============================================================================

const AppAction = Schema.Union(
  Schema.TaggedStruct('Tick', {}),
  Schema.TaggedStruct('Finish', {}),
  Schema.TaggedStruct('Interrupted', {}),
)

type AppAction = Schema.Schema.Type<typeof AppAction>

// =============================================================================
// Reducer
// =============================================================================

const appReducer = ({
  state,
  action,
}: {
  state: AppState
  action: AppAction
}): AppState => {
  switch (action._tag) {
    case 'Tick': {
      if (state._tag !== 'Displaying') return state
      return { ...state, secondsRemaining: state.secondsRemaining - 1 }
    }
    case 'Finish': {
      if (state._tag !== 'Displaying') return state
      return { _tag: 'Finished', message: 'Demo completed successfully!' }
    }
    case 'Interrupted': {
      // Only interrupt if still displaying (not already finished)
      if (state._tag !== 'Displaying') return state
      return { _tag: 'Interrupted' }
    }
  }
}

// =============================================================================
// View Components
// =============================================================================

const DisplayingView = ({ state }: { state: Extract<AppState, { _tag: 'Displaying' }> }) => (
  <Box flexDirection="column" padding={1}>
    <Text bold color="cyan">
      Hello from tui-react!
    </Text>
    <Text dim>A React renderer for terminal UIs</Text>
    <Box marginTop={1}>
      <Text>Colors: </Text>
      <Text color="red">red </Text>
      <Text color="green">green </Text>
      <Text color="blue">blue </Text>
      <Text color="yellow">yellow</Text>
    </Box>
    <Box marginTop={1}>
      <Text dim>Exiting in {state.secondsRemaining}s... (Ctrl+C to exit now)</Text>
    </Box>
  </Box>
)

const FinishedView = ({ state }: { state: Extract<AppState, { _tag: 'Finished' }> }) => (
  <Box flexDirection="column" padding={1}>
    <Text bold color="green">
      Hello World - Complete
    </Text>
    <Text>{state.message}</Text>
  </Box>
)

const InterruptedView = () => (
  <Box flexDirection="column" padding={1}>
    <Text bold color="yellow">
      Hello World - Interrupted
    </Text>
    <Text dim>Goodbye! Come back soon.</Text>
  </Box>
)

// =============================================================================
// Main Program
// =============================================================================

const runHelloWorld = (durationSeconds: number) =>
  Effect.gen(function* () {
    const HelloApp = createTuiApp({
      stateSchema: AppState,
      actionSchema: AppAction,
      initial: {
        _tag: 'Displaying',
        secondsRemaining: durationSeconds,
      } as AppState,
      reducer: appReducer,
      interruptTimeout: 200,
    })

    const HelloView = () => {
      const state = HelloApp.useState()
      switch (state._tag) {
        case 'Displaying':
          return <DisplayingView state={state} />
        case 'Finished':
          return <FinishedView state={state} />
        case 'Interrupted':
          return <InterruptedView />
      }
    }

    const tui = yield* HelloApp.run(<HelloView />)

    // Countdown timer
    for (let i = durationSeconds; i > 0; i--) {
      yield* Effect.sleep('1 second')
      if (tui.getState()._tag !== 'Displaying') break
      tui.dispatch({ _tag: 'Tick' })
    }

    // Finish if still displaying
    if (tui.getState()._tag === 'Displaying') {
      tui.dispatch({ _tag: 'Finish' })
    }
  }).pipe(Effect.scoped)

// =============================================================================
// CLI Command
// =============================================================================

const helloWorldCommand = Command.make(
  'hello-world',
  {
    duration: durationOption,
    ...outputModeOptions,
  },
  ({ duration, json, stream }) =>
    runHelloWorld(duration).pipe(
      Effect.provide(outputModeLayerFromFlagsWithTTY({ json, stream, visual })),
    ),
)

const cli = Command.run(helloWorldCommand, {
  name: 'Hello World',
  version: '1.0.0',
})

// Run with Effect CLI (handles SIGINT/SIGTERM properly)
cli(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain)
