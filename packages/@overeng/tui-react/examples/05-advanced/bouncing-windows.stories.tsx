/**
 * Bouncing Windows - Storybook Stories
 *
 * DVD screensaver style window manager simulation.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { createTuiApp } from '../../src/mod.tsx'
import { TuiStoryPreview } from '../../src/storybook/TuiStoryPreview.tsx'
import { AppState, AppAction, appReducer, createWindow } from './schema.ts'
import { BouncingWindowsView } from './view.tsx'

const BouncingApp = createTuiApp({
  stateSchema: AppState,
  actionSchema: AppAction,
  initial: {
    _tag: 'Running',
    windows: [createWindow({ id: 0, count: 1, width: 78, height: 20 })],
    frame: 0,
    termWidth: 78,
    termHeight: 20,
  } as typeof AppState.Type,
  reducer: appReducer,
})

// =============================================================================
// Initial States
// =============================================================================

const createRunningState = ({
  windowCount,
  width,
  height,
  frame = 0,
}: {
  windowCount: number
  width: number
  height: number
  frame?: number
}): typeof AppState.Type => ({
  _tag: 'Running',
  windows: Array.from({ length: windowCount }, (_, i) =>
    createWindow({ id: i, count: windowCount, width, height }),
  ),
  frame,
  termWidth: width,
  termHeight: height,
})

const finishedState = ({
  frames,
  windows,
}: {
  frames: number
  windows: number
}): typeof AppState.Type => ({
  _tag: 'Finished',
  totalFrames: frames,
  windowCount: windows,
})

const interruptedState = ({
  frame,
  windows,
}: {
  frame: number
  windows: number
}): typeof AppState.Type => ({
  _tag: 'Interrupted',
  frame,
  windowCount: windows,
})

// =============================================================================
// Timeline - simulates bouncing animation
// =============================================================================

const createBouncingTimeline = ({
  durationMs,
  frameMs = 80,
}: {
  durationMs: number
  frameMs?: number
}): Array<{ at: number; action: typeof AppAction.Type }> => {
  const events: Array<{ at: number; action: typeof AppAction.Type }> = []
  for (let t = frameMs; t < durationMs; t += frameMs) {
    events.push({ at: t, action: { _tag: 'Tick' } })
  }
  events.push({ at: durationMs, action: { _tag: 'Finish' } })
  return events
}

const demoTimeline = createBouncingTimeline({ durationMs: 5000, frameMs: 80 }) // 5 seconds

// =============================================================================
// Story Meta
// =============================================================================

export default {
  component: BouncingWindowsView,
  title: 'Examples/05 Advanced/Bouncing Windows',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: `
DVD screensaver style bouncing windows with fake system stats.

**Demonstrates:**
- Canvas-based rendering with colored windows
- Multiple animated elements with collision detection
- Stat bars that update over time
- Terminal resize handling

**CLI Usage:**
\`\`\`bash
bun examples/05-advanced/bouncing-windows.tsx
bun examples/05-advanced/bouncing-windows.tsx --count 3
bun examples/05-advanced/bouncing-windows.tsx --count 6 --duration 30
bun examples/05-advanced/bouncing-windows.tsx --json
\`\`\`
        `,
      },
    },
  },
} satisfies Meta

// =============================================================================
// Stories
// =============================================================================

type Story = StoryObj<{
  autoRun: boolean
  playbackSpeed: number
  height: number
  windowCount: number
  termWidth: number
  termHeight: number
}>

/**
 * Full demo with bouncing windows animation.
 */
export const Demo: Story = {
  args: {
    autoRun: true,
    playbackSpeed: 1,
    height: 500,
    windowCount: 3,
    termWidth: 80,
    termHeight: 24,
  },
  argTypes: {
    autoRun: { control: 'boolean', description: 'Auto-start animation' },
    playbackSpeed: { control: { type: 'range', min: 0.5, max: 3, step: 0.5 } },
    height: { control: { type: 'range', min: 300, max: 700, step: 50 } },
    windowCount: { control: { type: 'range', min: 1, max: 6, step: 1 } },
    termWidth: { control: { type: 'range', min: 60, max: 120, step: 10 } },
    termHeight: { control: { type: 'range', min: 16, max: 40, step: 4 } },
  },
  render: (args) => (
    <TuiStoryPreview
      View={BouncingWindowsView}
      app={BouncingApp}
      initialState={createRunningState({
        windowCount: args.windowCount,
        width: args.termWidth,
        height: args.termHeight,
      })}
      timeline={demoTimeline}
      autoRun={args.autoRun}
      playbackSpeed={args.playbackSpeed}
      height={args.height}
    />
  ),
}

/**
 * Single window bouncing.
 */
export const SingleWindow: Story = {
  args: {
    autoRun: true,
    playbackSpeed: 1,
    height: 450,
  },
  render: (args) => (
    <TuiStoryPreview
      View={BouncingWindowsView}
      app={BouncingApp}
      initialState={createRunningState({ windowCount: 1, width: 80, height: 20 })}
      timeline={demoTimeline}
      autoRun={args.autoRun}
      playbackSpeed={args.playbackSpeed}
      height={args.height}
    />
  ),
}

/**
 * Six windows - maximum chaos!
 */
export const SixWindows: Story = {
  args: {
    autoRun: true,
    playbackSpeed: 1,
    height: 550,
  },
  render: (args) => (
    <TuiStoryPreview
      View={BouncingWindowsView}
      app={BouncingApp}
      initialState={createRunningState({ windowCount: 6, width: 100, height: 28 })}
      timeline={demoTimeline}
      autoRun={args.autoRun}
      playbackSpeed={args.playbackSpeed}
      height={args.height}
    />
  ),
}

/**
 * Static view showing finished state.
 */
export const Finished: Story = {
  args: { height: 350 },
  render: (args) => (
    <TuiStoryPreview
      View={BouncingWindowsView}
      app={BouncingApp}
      initialState={finishedState({ frames: 300, windows: 3 })}
      height={args.height}
      autoRun={false}
    />
  ),
}

/**
 * Static view showing interrupted state.
 */
export const Interrupted: Story = {
  args: { height: 350 },
  render: (args) => (
    <TuiStoryPreview
      View={BouncingWindowsView}
      app={BouncingApp}
      initialState={interruptedState({ frame: 150, windows: 3 })}
      height={args.height}
      autoRun={false}
    />
  ),
}
