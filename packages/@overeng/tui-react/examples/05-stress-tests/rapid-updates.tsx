/**
 * Rapid Updates Stress Test
 *
 * Tests the renderer's ability to handle high-frequency updates.
 * Updates at ~60fps to verify differential rendering works correctly.
 *
 * Demonstrates:
 * - Effect CLI integration with proper signal handling
 * - createTuiApp pattern with proper state management
 * - Interrupted handling for graceful Ctrl+C
 * - Finished state for completion summary
 *
 * Run: bun examples/05-stress-tests/rapid-updates.tsx
 * Run with JSON: bun examples/05-stress-tests/rapid-updates.tsx --json
 */

import { Args, Command, Options } from '@effect/cli'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Effect, Fiber, Schema } from 'effect'
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
  Options.withDescription('Duration in seconds'),
  Options.withDefault(5),
)

// =============================================================================
// Configuration
// =============================================================================

const FRAME_MS = 16 // ~60fps

// =============================================================================
// State Schema
// =============================================================================

const RunningState = Schema.Struct({
  _tag: Schema.Literal('Running'),
  frame: Schema.Number,
  startTime: Schema.Number,
  fps: Schema.Number,
  progress: Schema.Number,
})

const FinishedState = Schema.Struct({
  _tag: Schema.Literal('Finished'),
  totalFrames: Schema.Number,
  averageFps: Schema.Number,
  duration: Schema.Number,
})

const InterruptedState = Schema.Struct({
  _tag: Schema.Literal('Interrupted'),
  frame: Schema.Number,
  fps: Schema.Number,
  progress: Schema.Number,
})

const StressTestState = Schema.Union(RunningState, FinishedState, InterruptedState)

type StressTestState = Schema.Schema.Type<typeof StressTestState>

// =============================================================================
// Action Schema
// =============================================================================

const StressTestAction = Schema.Union(
  Schema.TaggedStruct('Tick', {}),
  Schema.TaggedStruct('Finish', {}),
  Schema.TaggedStruct('Interrupted', {}),
)

type StressTestAction = Schema.Schema.Type<typeof StressTestAction>

// =============================================================================
// Reducer
// =============================================================================

const createReducer =
  (durationMs: number) =>
  ({
    state,
    action,
  }: {
    state: StressTestState
    action: StressTestAction
  }): StressTestState => {
    switch (action._tag) {
      case 'Tick': {
        if (state._tag !== 'Running') return state
        const frame = state.frame + 1
        const elapsed = Date.now() - state.startTime
        const fps = frame > 0 ? Math.round((frame / elapsed) * 1000) : 0
        const progress = Math.min(100, Math.round((elapsed / durationMs) * 100))
        return { ...state, frame, fps, progress }
      }

      case 'Finish': {
        if (state._tag !== 'Running') return state
        const elapsed = Date.now() - state.startTime
        return {
          _tag: 'Finished',
          totalFrames: state.frame,
          averageFps: state.frame > 0 ? Math.round((state.frame / elapsed) * 1000) : 0,
          duration: elapsed,
        }
      }

      case 'Interrupted': {
        if (state._tag !== 'Running') return state
        return {
          _tag: 'Interrupted',
          frame: state.frame,
          fps: state.fps,
          progress: state.progress,
        }
      }
    }
  }

// =============================================================================
// View Components
// =============================================================================

const ProgressBar = ({ progress, width = 40 }: { progress: number; width?: number }) => {
  const filled = Math.round((progress / 100) * width)
  return (
    <Box flexDirection="row">
      <Text>Progress: </Text>
      <Text color="green">{'█'.repeat(filled)}</Text>
      <Text dim>{'░'.repeat(width - filled)}</Text>
      <Text> {progress}%</Text>
    </Box>
  )
}

const Spinner = ({ frame }: { frame: number }) => {
  const spinnerChars = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  return (
    <Box flexDirection="row">
      <Text dim>Spinner: </Text>
      <Text color="cyan">{spinnerChars[frame % spinnerChars.length]}</Text>
    </Box>
  )
}

const RunningView = ({ state }: { state: Extract<StressTestState, { _tag: 'Running' }> }) => (
  <Box flexDirection="column" padding={1}>
    <Text bold color="cyan">
      Rapid Updates Stress Test
    </Text>
    <Text dim>Testing renderer at ~60fps</Text>

    <Box flexDirection="row" marginTop={1}>
      <Text>Frame: </Text>
      <Text color="yellow" bold>
        {state.frame.toString().padStart(5)}
      </Text>
    </Box>

    <Box flexDirection="row">
      <Text>FPS: </Text>
      <Text color={state.fps >= 50 ? 'green' : state.fps >= 30 ? 'yellow' : 'red'} bold>
        {state.fps.toString().padStart(3)}
      </Text>
    </Box>

    <ProgressBar progress={state.progress} />
    <Spinner frame={state.frame} />
  </Box>
)

const FinishedView = ({ state }: { state: Extract<StressTestState, { _tag: 'Finished' }> }) => (
  <Box flexDirection="column" padding={1}>
    <Text bold color="green">
      Stress Test Complete
    </Text>

    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text>Total Frames: </Text>
        <Text bold>{state.totalFrames}</Text>
      </Box>
      <Box flexDirection="row">
        <Text>Average FPS: </Text>
        <Text
          color={state.averageFps >= 50 ? 'green' : state.averageFps >= 30 ? 'yellow' : 'red'}
          bold
        >
          {state.averageFps}
        </Text>
      </Box>
      <Box flexDirection="row">
        <Text>Duration: </Text>
        <Text bold>{(state.duration / 1000).toFixed(1)}s</Text>
      </Box>
    </Box>

    <Text dim marginTop={1}>
      {state.averageFps >= 50
        ? 'Excellent! Renderer handled 60fps updates smoothly.'
        : state.averageFps >= 30
          ? 'Good performance, but some frames were dropped.'
          : 'Performance issues detected. Check terminal capabilities.'}
    </Text>
  </Box>
)

const InterruptedView = ({
  state,
}: {
  state: Extract<StressTestState, { _tag: 'Interrupted' }>
}) => (
  <Box flexDirection="column" padding={1}>
    <Text bold color="yellow">
      Stress Test Interrupted
    </Text>

    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text>Frames rendered: </Text>
        <Text bold>{state.frame}</Text>
      </Box>
      <Box flexDirection="row">
        <Text>Last FPS: </Text>
        <Text bold>{state.fps}</Text>
      </Box>
      <Box flexDirection="row">
        <Text>Progress: </Text>
        <Text bold>{state.progress}%</Text>
      </Box>
    </Box>

    <Text dim marginTop={1}>
      Test was cancelled by user (Ctrl+C).
    </Text>
  </Box>
)

// =============================================================================
// Main Program
// =============================================================================

const runStressTest = (durationMs: number) =>
  Effect.gen(function* () {
    // Create app with duration-specific reducer
    const StressTestApp = createTuiApp({
      stateSchema: StressTestState,
      actionSchema: StressTestAction,
      initial: {
        _tag: 'Running',
        frame: 0,
        startTime: Date.now(),
        fps: 0,
        progress: 0,
      } as StressTestState,
      reducer: createReducer(durationMs),
      interruptTimeout: 200,
    })

    // View component using the app's hooks
    const StressTestView = () => {
      const state = StressTestApp.useState()
      switch (state._tag) {
        case 'Running':
          return <RunningView state={state} />
        case 'Finished':
          return <FinishedView state={state} />
        case 'Interrupted':
          return <InterruptedView state={state} />
      }
    }

    const tui = yield* StressTestApp.run(<StressTestView />)

    // Run the animation loop
    const animationFiber = yield* Effect.fork(
      Effect.gen(function* () {
        while (tui.getState()._tag === 'Running') {
          tui.dispatch({ _tag: 'Tick' })
          yield* Effect.sleep(`${FRAME_MS} millis`)
        }
      }),
    )

    // Wait for duration to complete
    yield* Effect.sleep(`${durationMs} millis`)

    // Only finish if still running (might have been interrupted)
    if (tui.getState()._tag === 'Running') {
      tui.dispatch({ _tag: 'Finish' })
    }

    // Cancel animation fiber
    yield* Fiber.interrupt(animationFiber)
  }).pipe(Effect.scoped)

// =============================================================================
// CLI Command
// =============================================================================

const stressTestCommand = Command.make(
  'stress-test',
  {
    duration: durationOption,
    ...outputModeOptions,
  },
  ({ duration, json, stream }) =>
    runStressTest(duration * 1000).pipe(
      Effect.provide(outputModeLayerFromFlagsWithTTY({ json, stream, visual })),
    ),
)

const cli = Command.run(stressTestCommand, {
  name: 'Rapid Updates Stress Test',
  version: '1.0.0',
})

// Run with Effect CLI (handles SIGINT/SIGTERM properly)
cli(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain)
