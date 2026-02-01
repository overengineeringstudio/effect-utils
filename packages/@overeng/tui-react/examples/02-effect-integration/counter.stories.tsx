/**
 * Counter Example - Storybook Stories
 *
 * Demonstrates Effect integration with createTuiApp in Storybook with:
 * - Visual/Fullscreen/String/JSON/NDJSON tabs
 * - Timeline playback
 * - State controls
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { createTuiApp } from '../../src/mod.ts'
import { TuiStoryPreview } from '../../src/storybook/TuiStoryPreview.tsx'
import { CounterState, CounterAction, counterReducer } from './schema.ts'
import { CounterView } from './view.tsx'

const CounterApp = createTuiApp({
  stateSchema: CounterState,
  actionSchema: CounterAction,
  initial: { _tag: 'Running', count: 0, status: 'idle', history: [] } as typeof CounterState.Type,
  reducer: counterReducer,
})

// =============================================================================
// Initial States
// =============================================================================

const runningState = (count: number, history: string[] = []): typeof CounterState.Type => ({
  _tag: 'Running',
  count,
  status: 'idle',
  history,
})

const loadingState = (count: number): typeof CounterState.Type => ({
  _tag: 'Running',
  count,
  status: 'loading',
  history: [],
})

const completeState = (finalCount: number): typeof CounterState.Type => ({
  _tag: 'Complete',
  finalCount,
  history: [`Final count: ${finalCount}`],
})

const interruptedState = (count: number): typeof CounterState.Type => ({
  _tag: 'Interrupted',
  count,
  history: ['Interrupted by user'],
})

// =============================================================================
// Timeline - simulates CLI execution
// =============================================================================

const demoTimeline: Array<{ at: number; action: typeof CounterAction.Type }> = [
  { at: 400, action: { _tag: 'Increment' } },
  { at: 800, action: { _tag: 'Increment' } },
  { at: 1200, action: { _tag: 'Increment' } },
  { at: 1600, action: { _tag: 'SetLoading' } },
  { at: 2400, action: { _tag: 'Decrement' } },
  { at: 2800, action: { _tag: 'SetComplete', message: 'Final count: 2' } },
]

// =============================================================================
// Story Meta
// =============================================================================

export default {
  title: 'Examples/02 Effect/Counter',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: `
Counter example demonstrating Effect integration with createTuiApp.

**Demonstrates:**
- createTuiApp factory pattern
- State and Action schemas with Effect Schema
- Reducer pattern for state updates
- App-scoped hooks (CounterApp.useState)
- Sync dispatch (no yield* needed)
- Output mode support (--json flag)
- Graceful Ctrl+C handling

**CLI Usage:**
\`\`\`bash
bun examples/02-effect-integration/counter.tsx
bun examples/02-effect-integration/counter.tsx --json
bun examples/02-effect-integration/counter.tsx --help
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
}>

/**
 * Full demo with increment, loading, and completion.
 */
export const Demo: Story = {
  args: {
    autoRun: true,
    playbackSpeed: 1,
    height: 400,
  },
  argTypes: {
    autoRun: { control: 'boolean', description: 'Auto-start timeline' },
    playbackSpeed: { control: { type: 'range', min: 0.5, max: 3, step: 0.5 } },
    height: { control: { type: 'range', min: 200, max: 500, step: 50 } },
  },
  render: (args) => (
    <TuiStoryPreview
      View={CounterView}
      app={CounterApp}
      initialState={runningState(0)}
      timeline={demoTimeline}
      autoRun={args.autoRun}
      playbackSpeed={args.playbackSpeed}
      height={args.height}
    />
  ),
}

/**
 * Static view showing idle running state.
 */
export const Running: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={CounterView}
      app={CounterApp}
      initialState={runningState(5, ['[12:00:01] Incremented to 5'])}
      height={args.height}
      autoRun={false}
    />
  ),
}

/**
 * Static view showing loading state.
 */
export const Loading: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={CounterView}
      app={CounterApp}
      initialState={loadingState(3)}
      height={args.height}
      autoRun={false}
    />
  ),
}

/**
 * Static view showing complete state.
 */
export const Complete: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={CounterView}
      app={CounterApp}
      initialState={completeState(2)}
      height={args.height}
      autoRun={false}
    />
  ),
}

/**
 * Static view showing interrupted state.
 */
export const Interrupted: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={CounterView}
      app={CounterApp}
      initialState={interruptedState(3)}
      height={args.height}
      autoRun={false}
    />
  ),
}
