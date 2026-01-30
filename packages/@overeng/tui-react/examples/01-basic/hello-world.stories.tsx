/**
 * Hello World - Storybook Stories
 *
 * Demonstrates the simplest tui-react example in Storybook with:
 * - Visual/Fullscreen/String/JSON/NDJSON tabs
 * - Timeline playback
 * - State controls
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '../../src/storybook/TuiStoryPreview.tsx'
import { AppState, AppAction, appReducer } from './schema.ts'
import { HelloWorldView } from './view.tsx'

// =============================================================================
// Initial States
// =============================================================================

const displayingState = (secondsRemaining: number): typeof AppState.Type => ({
  _tag: 'Displaying',
  secondsRemaining,
})

const finishedState: typeof AppState.Type = {
  _tag: 'Finished',
  message: 'Demo completed successfully!',
}

const interruptedState: typeof AppState.Type = {
  _tag: 'Interrupted',
}

// =============================================================================
// Timeline - simulates CLI execution
// =============================================================================

const demoTimeline: Array<{ at: number; action: typeof AppAction.Type }> = [
  // Countdown from 3
  { at: 1000, action: { _tag: 'Tick' } }, // 3 -> 2
  { at: 2000, action: { _tag: 'Tick' } }, // 2 -> 1
  { at: 3000, action: { _tag: 'Tick' } }, // 1 -> 0
  { at: 3100, action: { _tag: 'Finish' } },
]

const interruptTimeline: Array<{ at: number; action: typeof AppAction.Type }> = [
  { at: 1000, action: { _tag: 'Tick' } },
  { at: 1500, action: { _tag: 'Interrupted' } },
]

// =============================================================================
// Story Meta
// =============================================================================

const meta: Meta = {
  title: 'Examples/01 Basic/Hello World',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: `
The simplest possible tui-react example.

**Demonstrates:**
- Effect CLI integration for proper signal handling
- createTuiApp pattern (even for simple apps)
- Using Box and Text components
- Basic styling (colors, bold)
- Graceful Ctrl+C handling

**CLI Usage:**
\`\`\`bash
bun examples/01-basic/hello-world.tsx
bun examples/01-basic/hello-world.tsx --json
bun examples/01-basic/hello-world.tsx --help
\`\`\`
        `,
      },
    },
  },
}

export default meta

// =============================================================================
// Stories
// =============================================================================

type Story = StoryObj<{
  autoRun: boolean
  playbackSpeed: number
  height: number
}>

/**
 * Full demo with countdown and auto-finish.
 */
export const Demo: Story = {
  args: {
    autoRun: true,
    playbackSpeed: 1,
    height: 300,
  },
  argTypes: {
    autoRun: { control: 'boolean', description: 'Auto-start timeline' },
    playbackSpeed: { control: { type: 'range', min: 0.5, max: 3, step: 0.5 } },
    height: { control: { type: 'range', min: 200, max: 500, step: 50 } },
  },
  render: (args) => (
    <TuiStoryPreview
      View={HelloWorldView}
      stateSchema={AppState}
      actionSchema={AppAction}
      reducer={appReducer}
      initialState={displayingState(3)}
      timeline={demoTimeline}
      autoRun={args.autoRun}
      playbackSpeed={args.playbackSpeed}
      height={args.height}
    />
  ),
}

/**
 * Static view showing the countdown state.
 */
export const Displaying: Story = {
  args: { height: 300 },
  render: (args) => (
    <TuiStoryPreview
      View={HelloWorldView}
      stateSchema={AppState}
      actionSchema={AppAction}
      reducer={appReducer}
      initialState={displayingState(3)}
      height={args.height}
      autoRun={false}
    />
  ),
}

/**
 * Static view showing the finished state.
 */
export const Finished: Story = {
  args: { height: 300 },
  render: (args) => (
    <TuiStoryPreview
      View={HelloWorldView}
      stateSchema={AppState}
      actionSchema={AppAction}
      reducer={appReducer}
      initialState={finishedState}
      height={args.height}
      autoRun={false}
    />
  ),
}

/**
 * Demo showing interrupt behavior (Ctrl+C).
 */
export const InterruptDemo: Story = {
  args: {
    autoRun: true,
    playbackSpeed: 1,
    height: 300,
  },
  render: (args) => (
    <TuiStoryPreview
      View={HelloWorldView}
      stateSchema={AppState}
      actionSchema={AppAction}
      reducer={appReducer}
      initialState={displayingState(3)}
      timeline={interruptTimeline}
      autoRun={args.autoRun}
      playbackSpeed={args.playbackSpeed}
      height={args.height}
    />
  ),
}

/**
 * Static view showing the interrupted state.
 */
export const Interrupted: Story = {
  args: { height: 300 },
  render: (args) => (
    <TuiStoryPreview
      View={HelloWorldView}
      stateSchema={AppState}
      actionSchema={AppAction}
      reducer={appReducer}
      initialState={interruptedState}
      height={args.height}
      autoRun={false}
    />
  ),
}
