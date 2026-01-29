/**
 * Interactive examples that can be run both in Storybook and via CLI.
 *
 * These examples demonstrate real-world usage patterns of @overeng/tui-react.
 * Use the Controls panel below to adjust parameters and test different states.
 *
 * CLI usage:
 *   npx tsx examples/sync-simulation.tsx
 *   npx tsx examples/logs-above-progress.tsx
 *   npx tsx examples/progress-list.tsx
 *   npx tsx examples/task-list-demo.tsx
 *   npx tsx examples/stress-rapid.tsx
 *   npx tsx examples/stress-lines.tsx
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { Box, Text } from '../mod.ts'
import {
  SyncSimulationExample,
  type SyncSimulationProps,
  type SyncPhase,
  LogsAboveProgressExample,
  type LogsAboveProgressExampleProps,
  ProgressListExample,
  type ProgressListExampleProps,
  SyncDeepSimulationExample,
  type SyncDeepSimulationExampleProps,
  type SyncDeepPhase,
  StressRapidExample,
  type StressRapidExampleProps,
  StressLinesExample,
  type StressLinesExampleProps,
  BouncingWindowsExample,
  type BouncingWindowsExampleProps,
  TextColorsExample,
  TextStylesExample,
} from './mod.ts'

const meta: Meta = {
  title: 'Examples',
  parameters: {
    docs: {
      description: {
        component:
          'Interactive examples demonstrating @overeng/tui-react capabilities. Use the Controls panel to adjust parameters.',
      },
    },
  },
}

export default meta

// =============================================================================
// Sync Simulation
// =============================================================================

/** Extended props for Storybook controls */
interface SyncSimulationStoryProps extends Omit<SyncSimulationProps, 'syncState'> {
  /** Current phase of the sync */
  phase: SyncPhase
  /** Index of the currently active task (0-based), -1 for none */
  activeIndex: number
}

type SyncSimulationStory = StoryObj<SyncSimulationStoryProps>

/**
 * Simulates a basic repository sync with TaskList component.
 *
 * Toggle `autoRun` off to manually control the sync state with `phase` and `activeIndex`.
 *
 * CLI: `npx tsx examples/task-list-demo.tsx`
 */
export const SyncSimulation: SyncSimulationStory = {
  args: {
    repos: ['effect', 'effect-utils', 'livestore', 'mr-all-blue', 'dotfiles'],
    workspaceName: 'my-workspace',
    workspacePath: '/Users/test/workspace',
    autoRun: true,
    phase: 'running',
    activeIndex: 2,
  },
  argTypes: {
    repos: {
      description: 'Repository names to simulate syncing',
      control: { type: 'object' },
    },
    workspaceName: {
      description: 'Workspace name shown in header',
      control: { type: 'text' },
    },
    workspacePath: {
      description: 'Workspace path shown in header',
      control: { type: 'text' },
    },
    autoRun: {
      description: 'Auto-run animation (disable to manually control state)',
      control: { type: 'boolean' },
    },
    phase: {
      description: 'Current sync phase (only when autoRun is off)',
      control: { type: 'select' },
      options: ['running', 'done'],
      if: { arg: 'autoRun', eq: false },
    },
    activeIndex: {
      description: 'Currently active task index (only when autoRun is off)',
      control: { type: 'range', min: -1, max: 4, step: 1 },
      if: { arg: 'autoRun', eq: false },
    },
  },
  render: ({ phase, activeIndex, autoRun = true, ...args }) => {
    if (autoRun) {
      return <SyncSimulationExample key="auto" autoRun={true} {...args} />
    }
    return (
      <SyncSimulationExample
        key={`${phase}-${activeIndex}`}
        autoRun={false}
        syncState={{ phase, activeIndex }}
        {...args}
      />
    )
  },
}

// =============================================================================
// Sync Deep Simulation
// =============================================================================

/** Extended props for Storybook controls */
interface SyncDeepSimulationStoryProps extends Omit<SyncDeepSimulationExampleProps, 'syncState'> {
  /** Maximum concurrent repos syncing at once */
  maxConcurrent: number
  /** Current phase of the sync */
  phase: SyncDeepPhase
  /** Number of completed repos */
  completedCount: number
}

type SyncDeepSimulationStory = StoryObj<SyncDeepSimulationStoryProps>

/**
 * Deep sync simulation with nested repositories.
 * Demonstrates the <Static> component for persistent logs above dynamic progress.
 *
 * Toggle `autoRun` off to manually control the sync state with `phase` and `completedCount`.
 *
 * CLI: `npx tsx examples/sync-simulation.tsx`
 */
export const SyncDeepSimulation: SyncDeepSimulationStory = {
  args: {
    speed: 1,
    maxConcurrent: 3,
    autoRun: true,
    phase: 'syncing',
    completedCount: 5,
  },
  argTypes: {
    speed: {
      description: 'Animation speed multiplier (higher = faster)',
      control: { type: 'range', min: 0.5, max: 5, step: 0.5 },
    },
    maxConcurrent: {
      description: 'Maximum repos syncing concurrently',
      control: { type: 'range', min: 1, max: 10, step: 1 },
    },
    autoRun: {
      description: 'Auto-run animation (disable to manually control state)',
      control: { type: 'boolean' },
    },
    phase: {
      description: 'Current sync phase (only when autoRun is off)',
      control: { type: 'select' },
      options: ['scanning', 'syncing', 'done'],
      if: { arg: 'autoRun', eq: false },
    },
    completedCount: {
      description: 'Number of completed repos (only when autoRun is off)',
      control: { type: 'range', min: 0, max: 12, step: 1 },
      if: { arg: 'autoRun', eq: false },
    },
  },
  render: ({ phase, completedCount, autoRun = true, ...args }) => {
    if (autoRun) {
      return (
        <SyncDeepSimulationExample key={`auto-${args.maxConcurrent}`} autoRun={true} {...args} />
      )
    }
    return (
      <SyncDeepSimulationExample
        key={`${phase}-${completedCount}-${args.maxConcurrent}`}
        autoRun={false}
        syncState={{ phase, completedCount }}
        {...args}
      />
    )
  },
}

// =============================================================================
// Logs Above Progress
// =============================================================================

type LogsAboveProgressStory = StoryObj<LogsAboveProgressExampleProps>

/**
 * Logs appearing above progress - demonstrates <Static> component.
 * Logs are rendered once and persist above the dynamic progress area.
 *
 * CLI: `npx tsx examples/logs-above-progress.tsx`
 */
export const LogsAboveProgress: LogsAboveProgressStory = {
  args: {
    speed: 1,
  },
  argTypes: {
    speed: {
      description: 'Animation speed multiplier (higher = faster)',
      control: { type: 'range', min: 0.5, max: 5, step: 0.5 },
    },
  },
  render: (args) => <LogsAboveProgressExample key={JSON.stringify(args)} {...args} />,
}

// =============================================================================
// Progress List
// =============================================================================

type ProgressListStory = StoryObj<ProgressListExampleProps>

/**
 * Progress list with animated spinners.
 * Shows a simple task list progressing through items.
 *
 * CLI: `npx tsx examples/progress-list.tsx`
 */
export const ProgressList: ProgressListStory = {
  args: {
    title: 'Installing dependencies...',
    items: ['typescript', 'react', 'effect', 'vitest', 'yoga-layout'],
    speed: 1,
  },
  argTypes: {
    title: {
      description: 'Title shown above the progress list',
      control: { type: 'text' },
    },
    items: {
      description: 'Items to show in the progress list',
      control: { type: 'object' },
    },
    speed: {
      description: 'Animation speed multiplier (higher = faster)',
      control: { type: 'range', min: 0.5, max: 5, step: 0.5 },
    },
  },
  render: (args) => <ProgressListExample key={JSON.stringify(args)} {...args} />,
}

// =============================================================================
// Stress Rapid
// =============================================================================

type StressRapidStory = StoryObj<StressRapidExampleProps>

/**
 * Rapid updates stress test.
 * Tests differential rendering performance with animated counters and progress bars.
 *
 * CLI: `npx tsx examples/stress-rapid.tsx`
 */
export const StressRapid: StressRapidStory = {
  args: {
    targetFps: 60,
    speed: 1,
  },
  argTypes: {
    targetFps: {
      description: 'Target frames per second',
      control: { type: 'range', min: 10, max: 120, step: 10 },
    },
    speed: {
      description: 'Animation speed multiplier',
      control: { type: 'range', min: 0.5, max: 3, step: 0.5 },
    },
  },
  render: (args) => <StressRapidExample key={JSON.stringify(args)} {...args} />,
}

// =============================================================================
// Stress Lines
// =============================================================================

type StressLinesStory = StoryObj<StressLinesExampleProps>

/**
 * Many lines stress test with auto-scroll.
 * Tests rendering performance with many concurrent items.
 *
 * CLI: `npx tsx examples/stress-lines.tsx`
 */
export const StressLines: StressLinesStory = {
  args: {
    totalItems: 30,
    visibleItems: 15,
    speed: 1,
  },
  argTypes: {
    totalItems: {
      description: 'Total number of items to process',
      control: { type: 'range', min: 10, max: 100, step: 5 },
    },
    visibleItems: {
      description: 'Number of visible items in viewport',
      control: { type: 'range', min: 5, max: 30, step: 1 },
    },
    speed: {
      description: 'Animation speed multiplier (higher = faster)',
      control: { type: 'range', min: 0.5, max: 5, step: 0.5 },
    },
  },
  render: (args) => <StressLinesExample key={JSON.stringify(args)} {...args} />,
}

// =============================================================================
// Basic Demo
// =============================================================================

/**
 * Basic demo showing text colors and styles.
 *
 * CLI: `npx tsx examples/basic.tsx`
 */
export const BasicDemo: StoryObj = {
  render: () => (
    <Box>
      <Text bold>@overeng/tui-react Demo</Text>
      <Text dim>────────────────────────</Text>

      <Box paddingTop={1}>
        <Text bold>Colors:</Text>
        <Box paddingLeft={2}>
          <TextColorsExample />
        </Box>
      </Box>

      <Box paddingTop={1}>
        <Text bold>Styles:</Text>
        <Box paddingLeft={2}>
          <TextStylesExample />
        </Box>
      </Box>

      <Box paddingTop={1}>
        <Text dim>This is a basic demo of @overeng/tui-react</Text>
      </Box>
    </Box>
  ),
}

// =============================================================================
// Bouncing Windows
// =============================================================================

type BouncingWindowsStory = StoryObj<BouncingWindowsExampleProps>

/**
 * DVD screensaver style bouncing windows with fake system stats.
 *
 * CLI: `npx tsx examples/bouncing-windows.tsx [count]`
 */
export const BouncingWindows: BouncingWindowsStory = {
  args: {
    windowCount: 3,
    width: 80,
    height: 28,
    frameMs: 80,
    autoRun: true,
  },
  argTypes: {
    windowCount: {
      description: 'Number of bouncing windows (1-6)',
      control: { type: 'range', min: 1, max: 6, step: 1 },
    },
    width: {
      description: 'Canvas width in characters',
      control: { type: 'range', min: 40, max: 120, step: 10 },
    },
    height: {
      description: 'Canvas height in characters',
      control: { type: 'range', min: 16, max: 40, step: 2 },
    },
    frameMs: {
      description: 'Animation frame interval in ms (lower = faster)',
      control: { type: 'range', min: 20, max: 200, step: 10 },
    },
    autoRun: {
      description: 'Auto-run animation',
      control: { type: 'boolean' },
    },
  },
  render: (args) => (
    <BouncingWindowsExample key={`${args.windowCount}-${args.width}-${args.height}`} {...args} />
  ),
}
