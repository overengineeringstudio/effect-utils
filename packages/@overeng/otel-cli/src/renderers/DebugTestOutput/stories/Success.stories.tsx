/**
 * DebugTest success stories
 *
 * Storybook stories for successful debug test command output scenarios.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useMemo } from 'react'

import {
  ALL_OUTPUT_TABS,
  TuiStoryPreview,
  commonArgTypes,
  createInteractiveProps,
  defaultStoryArgs,
} from '@overeng/tui-react/storybook'

import { DebugTestApp } from '../app.ts'
import { DebugTestView } from '../view.tsx'
import {
  allPassedConfig,
  createFinalState,
  createTimeline,
  partialProgressState,
  runningState,
} from './_fixtures.ts'

// =============================================================================
// Meta
// =============================================================================

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
}

export default {
  title: 'otel-cli/DebugTest/Success',
  component: DebugTestView,
  argTypes: {
    ...commonArgTypes,
  },
  args: {
    ...defaultStoryArgs,
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

// =============================================================================
// Stories
// =============================================================================

/** All 4 test steps passed. */
export const AllPassed: Story = {
  render: (args) => {
    const stateConfig = useMemo(() => allPassedConfig, [])

    return (
      <TuiStoryPreview
        View={DebugTestView}
        app={DebugTestApp}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        {...createInteractiveProps({
          args,
          staticState: createFinalState(stateConfig),
          idleState: runningState(),
          createTimeline: () => createTimeline(stateConfig),
        })}
      />
    )
  },
}

/** Mid-run snapshot: 2 passed, 1 running, 1 pending. */
export const PartialProgress: Story = {
  render: (args) => {
    const stateConfig = useMemo(() => allPassedConfig, [])

    return (
      <TuiStoryPreview
        View={DebugTestView}
        app={DebugTestApp}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        {...createInteractiveProps({
          args,
          staticState: partialProgressState(),
          idleState: runningState(),
          createTimeline: () => createTimeline(stateConfig),
        })}
      />
    )
  },
}
