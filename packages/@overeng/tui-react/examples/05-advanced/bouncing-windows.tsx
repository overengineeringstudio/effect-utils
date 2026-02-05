/**
 * Bouncing Windows - DVD screensaver style window manager simulation.
 *
 * Windows bounce around the terminal with fake system stats inside.
 *
 * Demonstrates:
 * - Effect CLI integration with proper signal handling
 * - createTuiApp pattern with state management
 * - Interrupted handling for graceful Ctrl+C
 * - Terminal resize handling
 *
 * Usage:
 *   bun examples/06-advanced/bouncing-windows.tsx
 *   bun examples/06-advanced/bouncing-windows.tsx --count 3
 *   bun examples/06-advanced/bouncing-windows.tsx --count 6 --duration 30
 *   bun examples/06-advanced/bouncing-windows.tsx --json
 *   bun examples/06-advanced/bouncing-windows.tsx --help
 */

import { Command, Options } from '@effect/cli'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Effect, Fiber } from 'effect'
import React from 'react'

import { createTuiApp, run, outputOption, outputModeLayer } from '../../src/mod.ts'
// Import from shared modules
import { AppState, AppAction, appReducer, createWindow } from './schema.ts'
import { BouncingWindowsView } from './view.tsx'

// =============================================================================
// CLI Options
// =============================================================================

const countOption = Options.integer('count').pipe(
  Options.withAlias('c'),
  Options.withDescription('Number of bouncing windows (1-6)'),
  Options.withDefault(1),
)

const durationOption = Options.integer('duration').pipe(
  Options.withAlias('d'),
  Options.withDescription('Duration in seconds'),
  Options.withDefault(60),
)

// =============================================================================
// Constants
// =============================================================================

const FRAME_MS = 80 // ~12fps

const getTermSize = () => ({
  width: (process.stdout.columns || 80) - 2,
  height: (process.stdout.rows || 24) - 4,
})

// =============================================================================
// Main Program
// =============================================================================

const runBouncingWindows = ({
  windowCount,
  durationMs,
}: {
  windowCount: number
  durationMs: number
}) => {
  const clampedCount = Math.min(Math.max(windowCount, 1), 6)
  const { width, height } = getTermSize()

  const BouncingApp = createTuiApp({
    stateSchema: AppState,
    actionSchema: AppAction,
    initial: {
      _tag: 'Running',
      windows: Array.from({ length: clampedCount }, (_, i) =>
        createWindow({ id: i, count: clampedCount, width, height }),
      ),
      frame: 0,
      termWidth: width,
      termHeight: height,
    } as typeof AppState.Type,
    reducer: appReducer,
  })

  return run(
    BouncingApp,
    (tui) =>
      Effect.gen(function* () {
        // Handle terminal resize
        const resizeHandler = () => {
          const { width, height } = getTermSize()
          tui.dispatch({ _tag: 'Resize', width, height })
        }
        process.stdout.on('resize', resizeHandler)

        // Animation loop
        const animationFiber = yield* Effect.fork(
          Effect.gen(function* () {
            while (tui.getState()._tag === 'Running') {
              tui.dispatch({ _tag: 'Tick' })
              yield* Effect.sleep(`${FRAME_MS} millis`)
            }
          }),
        )

        // Wait for duration
        yield* Effect.sleep(`${durationMs} millis`)

        // Only finish if still running
        if (tui.getState()._tag === 'Running') {
          tui.dispatch({ _tag: 'Finish' })
        }

        // Cleanup
        process.stdout.off('resize', resizeHandler)
        yield* Fiber.interrupt(animationFiber)
      }),
    { view: <BouncingWindowsView stateAtom={BouncingApp.stateAtom} /> },
  )
}

// =============================================================================
// CLI Command
// =============================================================================

const bouncingWindowsCommand = Command.make(
  'bouncing-windows',
  {
    count: countOption,
    duration: durationOption,
    output: outputOption,
  },
  ({ count, duration, output }) =>
    runBouncingWindows({ windowCount: count, durationMs: duration * 1000 }).pipe(
      Effect.provide(outputModeLayer(output)),
    ),
)

const cli = Command.run(bouncingWindowsCommand, {
  name: 'Bouncing Windows Demo',
  version: '1.0.0',
})

// Run with Effect CLI (handles SIGINT/SIGTERM properly)
cli(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain)
