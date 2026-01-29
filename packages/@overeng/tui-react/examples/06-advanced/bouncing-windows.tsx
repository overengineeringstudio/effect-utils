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
// Types
// =============================================================================

interface Window {
  id: number
  x: number
  y: number
  vx: number
  vy: number
  width: number
  height: number
  title: string
  color: Color
  stats: Stats
}

interface Stats {
  cpu: number
  mem: number
  disk: number
  net: number
}

type Color = 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan'

// =============================================================================
// Constants
// =============================================================================

const COLORS: Color[] = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan']
const TITLES = ['System', 'Monitor', 'Stats', 'Dashboard', 'Metrics', 'Status']
const FRAME_MS = 80 // ~12fps
const WIN_WIDTH = 22
const WIN_HEIGHT = 8

// Dynamic terminal size
const getTermSize = () => ({
  width: (process.stdout.columns || 80) - 2,
  height: (process.stdout.rows || 24) - 4,
})

// =============================================================================
// Helpers
// =============================================================================

const randomBetween = ({ min, max }: { min: number; max: number }) => Math.random() * (max - min) + min

const createWindow = ({ id, count }: { id: number; count: number }): Window => {
  const { width, height } = getTermSize()
  // Spread windows out initially
  const startX = (id * (width / count)) % Math.max(1, width - WIN_WIDTH)
  const startY = (id * 3) % Math.max(1, height - WIN_HEIGHT)

  return {
    id,
    x: startX,
    y: startY,
    vx: randomBetween({ min: 0.8, max: 2.0 }) * (Math.random() > 0.5 ? 1 : -1),
    vy: randomBetween({ min: 0.4, max: 1.0 }) * (Math.random() > 0.5 ? 1 : -1),
    width: WIN_WIDTH,
    height: WIN_HEIGHT,
    title: TITLES[id % TITLES.length] ?? 'Window',
    color: COLORS[id % COLORS.length] ?? 'cyan',
    stats: {
      cpu: Math.random() * 100,
      mem: Math.random() * 100,
      disk: Math.random() * 100,
      net: Math.random() * 1000,
    },
  }
}

const updateWindow = ({
  win,
  termWidth,
  termHeight,
}: {
  win: Window
  termWidth: number
  termHeight: number
}): Window => {
  let { x, y, vx, vy } = win

  // Move
  x += vx
  y += vy

  // Bounce off edges
  if (x <= 0) {
    x = 0
    vx = Math.abs(vx)
  }
  if (x + WIN_WIDTH >= termWidth) {
    x = termWidth - WIN_WIDTH
    vx = -Math.abs(vx)
  }
  if (y <= 0) {
    y = 0
    vy = Math.abs(vy)
  }
  if (y + WIN_HEIGHT >= termHeight) {
    y = termHeight - WIN_HEIGHT
    vy = -Math.abs(vy)
  }

  // Drift stats
  const stats = {
    cpu: Math.max(0, Math.min(100, win.stats.cpu + randomBetween({ min: -3, max: 3 }))),
    mem: Math.max(0, Math.min(100, win.stats.mem + randomBetween({ min: -2, max: 2 }))),
    disk: Math.max(0, Math.min(100, win.stats.disk + randomBetween({ min: -1, max: 1 }))),
    net: Math.max(0, Math.min(1000, win.stats.net + randomBetween({ min: -30, max: 30 }))),
  }

  return { ...win, x, y, vx, vy, stats }
}

// =============================================================================
// State Schema
// =============================================================================

const WindowSchema = Schema.Struct({
  id: Schema.Number,
  x: Schema.Number,
  y: Schema.Number,
  vx: Schema.Number,
  vy: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
  title: Schema.String,
  color: Schema.Literal('red', 'green', 'yellow', 'blue', 'magenta', 'cyan'),
  stats: Schema.Struct({
    cpu: Schema.Number,
    mem: Schema.Number,
    disk: Schema.Number,
    net: Schema.Number,
  }),
})

const RunningState = Schema.Struct({
  _tag: Schema.Literal('Running'),
  windows: Schema.Array(WindowSchema),
  frame: Schema.Number,
  termWidth: Schema.Number,
  termHeight: Schema.Number,
})

const FinishedState = Schema.Struct({
  _tag: Schema.Literal('Finished'),
  totalFrames: Schema.Number,
  windowCount: Schema.Number,
})

const InterruptedState = Schema.Struct({
  _tag: Schema.Literal('Interrupted'),
  frame: Schema.Number,
  windowCount: Schema.Number,
})

const AppState = Schema.Union(RunningState, FinishedState, InterruptedState)

type AppState = Schema.Schema.Type<typeof AppState>

// =============================================================================
// Action Schema
// =============================================================================

const AppAction = Schema.Union(
  Schema.TaggedStruct('Tick', {}),
  Schema.TaggedStruct('Resize', { width: Schema.Number, height: Schema.Number }),
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
      if (state._tag !== 'Running') return state
      const { width, height } = getTermSize()
      return {
        ...state,
        windows: state.windows.map((w) => updateWindow({ win: w, termWidth: width, termHeight: height })),
        frame: state.frame + 1,
        termWidth: width,
        termHeight: height,
      }
    }

    case 'Resize': {
      if (state._tag !== 'Running') return state
      return {
        ...state,
        termWidth: action.width,
        termHeight: action.height,
      }
    }

    case 'Finish': {
      if (state._tag !== 'Running') return state
      return {
        _tag: 'Finished',
        totalFrames: state.frame,
        windowCount: state.windows.length,
      }
    }

    case 'Interrupted': {
      if (state._tag !== 'Running') return state
      return {
        _tag: 'Interrupted',
        frame: state.frame,
        windowCount: state.windows.length,
      }
    }
  }
}

// =============================================================================
// Canvas rendering (with color support)
// =============================================================================

interface Cell {
  char: string
  color: Color | null
}

const renderWindowToCanvas = ({
  canvas,
  win,
  canvasWidth,
}: {
  canvas: Cell[][]
  win: Window
  canvasWidth: number
}) => {
  const x = Math.floor(win.x)
  const y = Math.floor(win.y)
  const { width, height, title, stats, color } = win
  const innerW = width - 2

  // Build window lines
  const lines = [
    '┌' + '─'.repeat(innerW) + '┐',
    '│' + ` ${title} `.padEnd(innerW, '─') + '│',
    '├' + '─'.repeat(innerW) + '┤',
    '│' + formatStat({ label: 'CPU', value: stats.cpu, width: innerW }) + '│',
    '│' + formatStat({ label: 'MEM', value: stats.mem, width: innerW }) + '│',
    '│' + formatStat({ label: 'DSK', value: stats.disk, width: innerW }) + '│',
    '│' + ` NET ${(stats.net / 100).toFixed(1).padStart(5)}Mb`.padEnd(innerW) + '│',
    '└' + '─'.repeat(innerW) + '┘',
  ]

  // Draw to canvas with color
  for (let row = 0; row < Math.min(lines.length, height); row++) {
    const line = lines[row]!
    const canvasY = y + row
    if (canvasY < 0 || canvasY >= canvas.length) continue

    for (let col = 0; col < line.length; col++) {
      const canvasX = x + col
      if (canvasX < 0 || canvasX >= canvasWidth) continue
      canvas[canvasY]![canvasX] = { char: line[col]!, color }
    }
  }
}

const formatStat = ({ label, value, width }: { label: string; value: number; width: number }): string => {
  const barW = width - 7 // label(3) + space + pct(3)
  const filled = Math.round((value / 100) * barW)
  const bar = '█'.repeat(filled) + '░'.repeat(barW - filled)
  return `${label} ${bar}${Math.round(value).toString().padStart(3)}`
}

const createCanvas = ({ width, height }: { width: number; height: number }): Cell[][] => {
  return Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({ char: ' ', color: null })),
  )
}

// =============================================================================
// View Components
// =============================================================================

const CanvasRenderer = ({
  windows,
  width,
  height,
}: {
  windows: Window[]
  width: number
  height: number
}) => {
  // Create fresh canvas
  const canvas = createCanvas({ width, height })

  // Draw each window (last = on top)
  for (const win of windows) {
    renderWindowToCanvas({ canvas, win, canvasWidth: width })
  }

  // Convert canvas to colored lines
  const renderedLines = canvas.map((row, rowIdx) => {
    const segments: React.ReactNode[] = []
    let currentColor: Color | null = null
    let currentText = ''

    for (let col = 0; col < row.length; col++) {
      const cell = row[col]!
      if (cell.color !== currentColor) {
        // Flush current segment
        if (currentText) {
          segments.push(
            currentColor ? (
              <Text key={`${rowIdx}-${segments.length}`} color={currentColor}>
                {currentText}
              </Text>
            ) : (
              <Text key={`${rowIdx}-${segments.length}`}>{currentText}</Text>
            ),
          )
        }
        currentColor = cell.color
        currentText = cell.char
      } else {
        currentText += cell.char
      }
    }
    // Flush final segment
    if (currentText) {
      segments.push(
        currentColor ? (
          <Text key={`${rowIdx}-${segments.length}`} color={currentColor}>
            {currentText}
          </Text>
        ) : (
          <Text key={`${rowIdx}-${segments.length}`}>{currentText}</Text>
        ),
      )
    }

    return (
      <Box key={rowIdx} flexDirection="row">
        {segments}
      </Box>
    )
  })

  return <Box>{renderedLines}</Box>
}

const RunningView = ({ state }: { state: Extract<AppState, { _tag: 'Running' }> }) => (
  <Box>
    <Box flexDirection="row">
      <Text bold color="cyan">
        Bouncing Windows
      </Text>
      <Text dim>
        {' '}
        │ {state.windows.length} window{state.windows.length > 1 ? 's' : ''}
      </Text>
      <Text dim> │ Frame: {state.frame}</Text>
      <Text dim>
        {' '}
        │ {state.termWidth}x{state.termHeight}
      </Text>
      <Text dim> │ Ctrl+C to exit</Text>
    </Box>
    <Text dim>{'─'.repeat(state.termWidth)}</Text>
    <CanvasRenderer windows={state.windows} width={state.termWidth} height={state.termHeight} />
    <Text dim>{'─'.repeat(state.termWidth)}</Text>
  </Box>
)

const FinishedView = ({ state }: { state: Extract<AppState, { _tag: 'Finished' }> }) => (
  <Box flexDirection="column" padding={1}>
    <Text bold color="green">
      Bouncing Windows - Finished
    </Text>
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text>Total Frames: </Text>
        <Text bold>{state.totalFrames}</Text>
      </Box>
      <Box flexDirection="row">
        <Text>Windows: </Text>
        <Text bold>{state.windowCount}</Text>
      </Box>
    </Box>
    <Text dim marginTop={1}>
      Demo completed after reaching the time limit.
    </Text>
  </Box>
)

const InterruptedView = ({ state }: { state: Extract<AppState, { _tag: 'Interrupted' }> }) => (
  <Box flexDirection="column" padding={1}>
    <Text bold color="yellow">
      Bouncing Windows - Interrupted
    </Text>
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text>Frames rendered: </Text>
        <Text bold>{state.frame}</Text>
      </Box>
      <Box flexDirection="row">
        <Text>Windows: </Text>
        <Text bold>{state.windowCount}</Text>
      </Box>
    </Box>
    <Text dim marginTop={1}>
      Demo was cancelled by user (Ctrl+C).
    </Text>
  </Box>
)

// =============================================================================
// Main Program
// =============================================================================

const runBouncingWindows = ({
  windowCount,
  durationMs,
}: {
  windowCount: number
  durationMs: number
}) =>
  Effect.gen(function* () {
    const clampedCount = Math.min(Math.max(windowCount, 1), 6)
    const { width, height } = getTermSize()

    const BouncingApp = createTuiApp({
      stateSchema: AppState,
      actionSchema: AppAction,
      initial: {
        _tag: 'Running',
        windows: Array.from({ length: clampedCount }, (_, i) => createWindow({ id: i, count: clampedCount })),
        frame: 0,
        termWidth: width,
        termHeight: height,
      } as AppState,
      reducer: appReducer,
      interruptTimeout: 200,
    })

    const BouncingView = () => {
      const state = BouncingApp.useState()
      switch (state._tag) {
        case 'Running':
          return <RunningView state={state} />
        case 'Finished':
          return <FinishedView state={state} />
        case 'Interrupted':
          return <InterruptedView state={state} />
      }
    }

    const tui = yield* BouncingApp.run(<BouncingView />)

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
  }).pipe(Effect.scoped)

// =============================================================================
// CLI Command
// =============================================================================

const bouncingWindowsCommand = Command.make(
  'bouncing-windows',
  {
    count: countOption,
    duration: durationOption,
    ...outputModeOptions,
  },
  ({ count, duration, json, stream }) =>
    runBouncingWindows({ windowCount: count, durationMs: duration * 1000 }).pipe(
      Effect.provide(outputModeLayerFromFlagsWithTTY({ json, stream, visual })),
    ),
)

const cli = Command.run(bouncingWindowsCommand, {
  name: 'Bouncing Windows Demo',
  version: '1.0.0',
})

// Run with Effect CLI (handles SIGINT/SIGTERM properly)
cli(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain)
