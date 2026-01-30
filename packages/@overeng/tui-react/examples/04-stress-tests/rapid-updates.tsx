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

import { Command, Options } from '@effect/cli'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Effect, Fiber } from 'effect'
import React from 'react'

import {
  createTuiApp,
  outputOption,
  outputModeLayer,
} from '../../src/mod.ts'

// Import from shared modules
import { StressTestState, StressTestAction, createStressTestReducer } from './schema.ts'
import { StressTestView } from './view.tsx'

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
// Main Program
// =============================================================================

const runStressTest = (durationMs: number) =>
  Effect.gen(function* () {
    const StressTestApp = createTuiApp({
      stateSchema: StressTestState,
      actionSchema: StressTestAction,
      initial: {
        _tag: 'Running',
        frame: 0,
        startTime: Date.now(),
        fps: 0,
        progress: 0,
      } as typeof StressTestState.Type,
      reducer: createStressTestReducer(durationMs),
      interruptTimeout: 200,
    })

    // Connected view using app-scoped hook
    const ConnectedStressTestView = () => {
      const state = StressTestApp.useState()
      return <StressTestView state={state} />
    }

    const tui = yield* StressTestApp.run(<ConnectedStressTestView />)

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
    output: outputOption,
  },
  ({ duration, output }) => runStressTest(duration * 1000).pipe(Effect.provide(outputModeLayer(output))),
)

const cli = Command.run(stressTestCommand, {
  name: 'Rapid Updates Stress Test',
  version: '1.0.0',
})

// Run with Effect CLI (handles SIGINT/SIGTERM properly)
cli(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain)
