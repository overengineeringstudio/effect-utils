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
import { Duration, Effect } from 'effect'
import React from 'react'

import { createTuiApp, run } from '../../src/mod.tsx'
import { outputOption, outputModeLayer } from '../../src/node/mod.ts'
// Import from shared modules
import { CounterState, CounterAction, counterReducer } from './schema.ts'
import { CounterView } from './view.tsx'

// =============================================================================
// Main Program
// =============================================================================

const CounterApp = createTuiApp({
  stateSchema: CounterState,
  actionSchema: CounterAction,
  initial: {
    _tag: 'Running',
    count: 0,
    status: 'idle',
    history: [],
  } as typeof CounterState.Type,
  reducer: counterReducer,
})

const runCounter = run(
  CounterApp,
  (tui) =>
    Effect.gen(function* () {
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
        const state = tui.getState() as Extract<typeof CounterState.Type, { _tag: 'Running' }>
        tui.dispatch({ _tag: 'SetComplete', message: `Final count: ${state.count}` })
      }

      return { finalCount: (tui.getState() as any).finalCount ?? (tui.getState() as any).count }
    }),
  { view: <CounterView stateAtom={CounterApp.stateAtom} /> },
)

// =============================================================================
// CLI Command
// =============================================================================

const counter = Command.make('counter', { output: outputOption }, ({ output }) =>
  runCounter.pipe(Effect.provide(outputModeLayer(output))),
)

const cli = Command.run(counter, {
  name: 'counter',
  version: '1.0.0',
})

// Run with Effect CLI (handles SIGINT/SIGTERM properly)
cli(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain)
