/**
 * Log Capture Example - CLI Entry Point
 *
 * Demonstrates automatic log capture in progressive-visual modes.
 * Both Effect.log() and console.log() calls are captured and displayed
 * in the Static region via useCapturedLogs(), without corrupting the TUI.
 *
 * Run:
 *   bun examples/06-log-capture/log-capture.tsx
 *   bun examples/06-log-capture/log-capture.tsx --output json
 */

import { Command } from '@effect/cli'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Duration, Effect } from 'effect'
import React from 'react'

import { createTuiApp, run } from '../../src/mod.ts'
import { outputOption, outputModeLayer } from '../../src/node/mod.ts'
import { TaskRunnerState, TaskRunnerAction, taskRunnerReducer } from './schema.ts'
import { TaskRunnerView } from './view.tsx'

// =============================================================================
// Main Program
// =============================================================================

const tasks = ['lint', 'typecheck', 'test', 'build']

const App = createTuiApp({
  stateSchema: TaskRunnerState,
  actionSchema: TaskRunnerAction,
  initial: {
    _tag: 'Running',
    tasks: tasks.map((name) => ({ name, status: 'pending' as const })),
    currentTaskName: '',
  } as typeof TaskRunnerState.Type,
  reducer: taskRunnerReducer,
})

const runTaskRunner = run(
  App,
  (tui) =>
    Effect.gen(function* () {
      // Simulate running tasks with mixed log sources
      for (const taskName of tasks) {
        // These logs are captured in tty mode, not printed to stdout
        yield* Effect.log(`Starting task: ${taskName}`)
        tui.dispatch({ _tag: 'StartTask', name: taskName })

        yield* Effect.sleep(Duration.millis(500))

        // console.log is also captured
        console.log(`Task ${taskName} completed successfully`)
        tui.dispatch({ _tag: 'CompleteTask', name: taskName })

        yield* Effect.sleep(Duration.millis(200))
      }

      yield* Effect.log('All tasks finished')
      tui.dispatch({ _tag: 'Finish' })
    }),
  { view: <TaskRunnerView stateAtom={App.stateAtom} /> },
)

// =============================================================================
// CLI Command
// =============================================================================

const logCaptureCmd = Command.make('log-capture', { output: outputOption }, ({ output }) =>
  runTaskRunner.pipe(Effect.provide(outputModeLayer(output))),
)

const cli = Command.run(logCaptureCmd, {
  name: 'log-capture',
  version: '1.0.0',
})

cli(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain)
