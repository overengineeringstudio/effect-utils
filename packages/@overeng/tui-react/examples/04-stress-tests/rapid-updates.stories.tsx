/**
 * Rapid Updates Stress Test - Storybook Stories
 *
 * Tests the renderer's ability to handle high-frequency updates.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { createTuiApp } from '../../src/mod.ts'
import { TuiStoryPreview } from '../../src/storybook/TuiStoryPreview.tsx'
import { StressTestState, StressTestAction, stressTestReducer } from './schema.ts'
import { StressTestView } from './view.tsx'

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
  reducer: stressTestReducer,
})

// =============================================================================
// Initial States
// =============================================================================

const runningState = (
  frame: number,
  fps: number,
  progress: number,
): typeof StressTestState.Type => ({
  _tag: 'Running',
  frame,
  startTime: Date.now() - frame * 16, // Approximate based on 60fps
  fps,
  progress,
})

const finishedState = (totalFrames: number, avgFps: number): typeof StressTestState.Type => ({
  _tag: 'Finished',
  totalFrames,
  averageFps: avgFps,
  duration: Math.round((totalFrames / avgFps) * 1000),
})

const interruptedState = (
  frame: number,
  fps: number,
  progress: number,
): typeof StressTestState.Type => ({
  _tag: 'Interrupted',
  frame,
  fps,
  progress,
})

// =============================================================================
// Timeline - simulates rapid updates
// =============================================================================

// Create a timeline with rapid ticks
const createRapidTimeline = (
  durationMs: number,
  frameMs: number = 100,
): Array<{ at: number; action: typeof StressTestAction.Type }> => {
  const events: Array<{ at: number; action: typeof StressTestAction.Type }> = []
  for (let t = frameMs; t < durationMs; t += frameMs) {
    events.push({ at: t, action: { _tag: 'Tick' } })
  }
  events.push({ at: durationMs, action: { _tag: 'Finish' } })
  return events
}

const demoTimeline = createRapidTimeline(3000, 100) // 3 seconds, tick every 100ms

// =============================================================================
// Story Meta
// =============================================================================

export default {
  title: 'Examples/04 Stress/Rapid Updates',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: `
Rapid updates stress test - tests differential rendering performance.

**Demonstrates:**
- High-frequency state updates
- Animated progress bar and spinner
- FPS tracking and display
- Performance metrics

**CLI Usage:**
\`\`\`bash
bun examples/04-stress-tests/rapid-updates.tsx
bun examples/04-stress-tests/rapid-updates.tsx --duration 10
bun examples/04-stress-tests/rapid-updates.tsx --json
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
 * Full demo with rapid updates and completion.
 */
export const Demo: Story = {
  args: {
    autoRun: true,
    playbackSpeed: 1,
    height: 350,
  },
  argTypes: {
    autoRun: { control: 'boolean', description: 'Auto-start timeline' },
    playbackSpeed: { control: { type: 'range', min: 0.5, max: 3, step: 0.5 } },
    height: { control: { type: 'range', min: 200, max: 500, step: 50 } },
  },
  render: (args) => (
    <TuiStoryPreview
      View={StressTestView}
      app={StressTestApp}
      initialState={runningState(0, 0, 0)}
      timeline={demoTimeline}
      autoRun={args.autoRun}
      playbackSpeed={args.playbackSpeed}
      height={args.height}
    />
  ),
}

/**
 * Static view showing running state mid-test.
 */
export const Running: Story = {
  args: { height: 350 },
  render: (args) => (
    <TuiStoryPreview
      View={StressTestView}
      app={StressTestApp}
      initialState={runningState(150, 58, 50)}
      height={args.height}
      autoRun={false}
    />
  ),
}

/**
 * Static view showing excellent performance completion.
 */
export const FinishedExcellent: Story = {
  args: { height: 350 },
  render: (args) => (
    <TuiStoryPreview
      View={StressTestView}
      app={StressTestApp}
      initialState={finishedState(300, 60)}
      height={args.height}
      autoRun={false}
    />
  ),
}

/**
 * Static view showing good performance completion.
 */
export const FinishedGood: Story = {
  args: { height: 350 },
  render: (args) => (
    <TuiStoryPreview
      View={StressTestView}
      app={StressTestApp}
      initialState={finishedState(200, 40)}
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
      View={StressTestView}
      app={StressTestApp}
      initialState={interruptedState(100, 55, 33)}
      height={args.height}
      autoRun={false}
    />
  ),
}
