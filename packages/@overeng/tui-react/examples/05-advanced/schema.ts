/**
 * Bouncing Windows - State and Action Schemas
 */

import { Schema } from 'effect'

// =============================================================================
// Types
// =============================================================================

export interface Window {
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

export interface Stats {
  cpu: number
  mem: number
  disk: number
  net: number
}

export type Color = 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan'

// =============================================================================
// Constants
// =============================================================================

export const COLORS: Color[] = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan']
export const TITLES = ['System', 'Monitor', 'Stats', 'Dashboard', 'Metrics', 'Status']
export const WIN_WIDTH = 22
export const WIN_HEIGHT = 8

// =============================================================================
// Helpers
// =============================================================================

const randomBetween = ({ min, max }: { min: number; max: number }) =>
  Math.random() * (max - min) + min

export const createWindow = ({
  id,
  count,
  width,
  height,
}: {
  id: number
  count: number
  width: number
  height: number
}): Window => {
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

export const updateWindow = ({
  win,
  termWidth,
  termHeight,
}: {
  win: Window
  termWidth: number
  termHeight: number
}): Window => {
  let { x, y, vx, vy } = win

  x += vx
  y += vy

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

export const RunningState = Schema.Struct({
  _tag: Schema.Literal('Running'),
  windows: Schema.Array(WindowSchema),
  frame: Schema.Number,
  termWidth: Schema.Number,
  termHeight: Schema.Number,
})

export const FinishedState = Schema.Struct({
  _tag: Schema.Literal('Finished'),
  totalFrames: Schema.Number,
  windowCount: Schema.Number,
})

export const InterruptedState = Schema.Struct({
  _tag: Schema.Literal('Interrupted'),
  frame: Schema.Number,
  windowCount: Schema.Number,
})

export const AppState = Schema.Union(RunningState, FinishedState, InterruptedState)

export type AppState = Schema.Schema.Type<typeof AppState>

// =============================================================================
// Action Schema
// =============================================================================

export const AppAction = Schema.Union(
  Schema.TaggedStruct('Tick', {}),
  Schema.TaggedStruct('Resize', { width: Schema.Number, height: Schema.Number }),
  Schema.TaggedStruct('Finish', {}),
  Schema.TaggedStruct('Interrupted', {}),
)

export type AppAction = Schema.Schema.Type<typeof AppAction>

// =============================================================================
// Reducer
// =============================================================================

export const appReducer = ({ state, action }: { state: AppState; action: AppAction }): AppState => {
  switch (action._tag) {
    case 'Tick': {
      if (state._tag !== 'Running') return state
      return {
        ...state,
        windows: state.windows.map((w) =>
          updateWindow({
            win: w as Window,
            termWidth: state.termWidth,
            termHeight: state.termHeight,
          }),
        ),
        frame: state.frame + 1,
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
