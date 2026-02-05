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
import { Effect } from 'effect'
import React from 'react'

import { createTuiApp, run, outputOption, outputModeLayer } from '../../src/mod.ts'
// Import from shared modules
import { AppState, AppAction, appReducer } from './schema.ts'
import { HelloWorldView } from './view.tsx'

// =============================================================================
// CLI Options
// =============================================================================

const durationOption = Options.integer('duration').pipe(
  Options.withAlias('d'),
  Options.withDescription('Duration in seconds before auto-exit'),
  Options.withDefault(3),
)

// =============================================================================
// Main Program
// =============================================================================

const runHelloWorld = (durationSeconds: number) => {
  const HelloApp = createTuiApp({
    stateSchema: AppState,
    actionSchema: AppAction,
    initial: {
      _tag: 'Displaying',
      secondsRemaining: durationSeconds,
    } as typeof AppState.Type,
    reducer: appReducer,
  })

  return run(
    HelloApp,
    (tui) =>
      Effect.gen(function* () {
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
      }),
    { view: <HelloWorldView stateAtom={HelloApp.stateAtom} /> },
  )
}

// =============================================================================
// CLI Command
// =============================================================================

const helloWorldCommand = Command.make(
  'hello-world',
  {
    duration: durationOption,
    output: outputOption,
  },
  ({ duration, output }) => runHelloWorld(duration).pipe(Effect.provide(outputModeLayer(output))),
)

const cli = Command.run(helloWorldCommand, {
  name: 'Hello World',
  version: '1.0.0',
})

// Run with Effect CLI (handles SIGINT/SIGTERM properly)
cli(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain)
