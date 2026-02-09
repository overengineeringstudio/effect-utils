/**
 * Health success stories
 *
 * Storybook stories for successful health command output scenarios.
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

import { HealthApp } from '../app.ts'
import { HealthView } from '../view.tsx'
import {
  allHealthyConfig,
  createFinalState,
  createTimeline,
  loadingState,
  partiallyUnhealthyConfig,
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
  title: 'otel-cli/Health/Success',
  component: HealthView,
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

/** All components healthy. */
export const AllHealthy: Story = {
  render: (args) => {
    const stateConfig = useMemo(() => allHealthyConfig, [])

    return (
      <TuiStoryPreview
        View={HealthView}
        app={HealthApp}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        {...createInteractiveProps({
          args,
          staticState: createFinalState(stateConfig),
          idleState: loadingState(),
          createTimeline: () => createTimeline(stateConfig),
        })}
      />
    )
  },
}

/** Some components unhealthy. */
export const PartiallyUnhealthy: Story = {
  render: (args) => {
    const stateConfig = useMemo(() => partiallyUnhealthyConfig, [])

    return (
      <TuiStoryPreview
        View={HealthView}
        app={HealthApp}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        {...createInteractiveProps({
          args,
          staticState: createFinalState(stateConfig),
          idleState: loadingState(),
          createTimeline: () => createTimeline(stateConfig),
        })}
      />
    )
  },
}
