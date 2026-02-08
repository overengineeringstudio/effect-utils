/**
 * DebugTest error stories
 *
 * Storybook stories for debug test command failure scenarios.
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
import { createFinalState, createTimeline, runningState, someFailedConfig } from './_fixtures.ts'

// =============================================================================
// Meta
// =============================================================================

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
}

export default {
  title: 'otel-cli/DebugTest/Errors',
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

/** Tempo and Grafana steps failed. */
export const SomeFailed: Story = {
  render: (args) => {
    const stateConfig = useMemo(() => someFailedConfig, [])

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
