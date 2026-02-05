/**
 * Log Capture Example - Storybook Stories
 *
 * Demonstrates automatic log capture with useCapturedLogs().
 * In progressive-visual modes, Effect.log() and console.log() output
 * appears in the Static region instead of corrupting the TUI.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { createTuiApp } from '../../src/mod.ts'
import { TuiStoryPreview } from '../../src/storybook/TuiStoryPreview.tsx'
import { TaskRunnerState, TaskRunnerAction, taskRunnerReducer } from './schema.ts'
import { TaskRunnerView } from './view.tsx'

const TaskRunnerApp = createTuiApp({
  stateSchema: TaskRunnerState,
  actionSchema: TaskRunnerAction,
  initial: {
    _tag: 'Running',
    tasks: [
      { name: 'lint', status: 'pending' },
      { name: 'typecheck', status: 'pending' },
      { name: 'test', status: 'pending' },
      { name: 'build', status: 'pending' },
    ],
    currentTaskName: '',
  } as typeof TaskRunnerState.Type,
  reducer: taskRunnerReducer,
})

// =============================================================================
// Initial States
// =============================================================================

const initialState: typeof TaskRunnerState.Type = {
  _tag: 'Running',
  tasks: [
    { name: 'lint', status: 'pending' },
    { name: 'typecheck', status: 'pending' },
    { name: 'test', status: 'pending' },
    { name: 'build', status: 'pending' },
  ],
  currentTaskName: '',
}

const completeState: typeof TaskRunnerState.Type = {
  _tag: 'Complete',
  tasks: [
    { name: 'lint', status: 'done' },
    { name: 'typecheck', status: 'done' },
    { name: 'test', status: 'done' },
    { name: 'build', status: 'done' },
  ],
  totalTasks: 4,
}

// =============================================================================
// Timeline
// =============================================================================

const demoTimeline: Array<{ at: number; action: typeof TaskRunnerAction.Type }> = [
  { at: 200, action: { _tag: 'StartTask', name: 'lint' } },
  { at: 700, action: { _tag: 'CompleteTask', name: 'lint' } },
  { at: 900, action: { _tag: 'StartTask', name: 'typecheck' } },
  { at: 1600, action: { _tag: 'CompleteTask', name: 'typecheck' } },
  { at: 1800, action: { _tag: 'StartTask', name: 'test' } },
  { at: 2800, action: { _tag: 'CompleteTask', name: 'test' } },
  { at: 3000, action: { _tag: 'StartTask', name: 'build' } },
  { at: 3800, action: { _tag: 'CompleteTask', name: 'build' } },
  { at: 4000, action: { _tag: 'Finish' } },
]

// =============================================================================
// Story Meta
// =============================================================================

export default {
  component: TaskRunnerView,
  title: 'Examples/06 Log Capture/Task Runner',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: `
Log capture example demonstrating automatic capture of Effect.log() and console.log()
in progressive-visual modes.

**Demonstrates:**
- Automatic log capture in tty/ci modes
- \`useCapturedLogs()\` hook for rendering captured entries
- Captured logs in Static region above dynamic progress
- No TUI corruption from accidental console output

**Note:** In Storybook, log capture is not active (no outputModeLayer).
The \`useCapturedLogs()\` hook returns an empty array here. In CLI mode,
logs from \`Effect.log()\` and \`console.log()\` would appear in the
Static region above the task list.

**CLI Usage:**
\`\`\`bash
bun examples/06-log-capture/log-capture.tsx
bun examples/06-log-capture/log-capture.tsx --output json
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
 * Full demo with tasks starting and completing.
 * In CLI, captured logs would appear in the Static region above.
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
      View={TaskRunnerView}
      app={TaskRunnerApp}
      initialState={initialState}
      timeline={demoTimeline}
      autoRun={args.autoRun}
      playbackSpeed={args.playbackSpeed}
      height={args.height}
    />
  ),
}

/**
 * Static view showing pending tasks.
 */
export const Pending: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={TaskRunnerView}
      app={TaskRunnerApp}
      initialState={initialState}
      height={args.height}
      autoRun={false}
    />
  ),
}

/**
 * Static view showing all tasks complete.
 */
export const Complete: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={TaskRunnerView}
      app={TaskRunnerApp}
      initialState={completeState}
      height={args.height}
      autoRun={false}
    />
  ),
}
