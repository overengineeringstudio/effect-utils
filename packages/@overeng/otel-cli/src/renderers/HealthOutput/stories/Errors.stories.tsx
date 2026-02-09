/**
 * Health error stories
 *
 * Storybook stories for health command error and failure scenarios.
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
  allUnhealthyConfig,
  createErrorTimeline,
  createFinalState,
  createTimeline,
  errorState,
  loadingState,
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
  title: 'otel-cli/Health/Errors',
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

/** All components down. */
export const AllUnhealthy: Story = {
  render: (args) => {
    const stateConfig = useMemo(() => allUnhealthyConfig, [])

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

/** Configuration error. */
export const Error: Story = {
  render: (args) => {
    const finalState = useMemo(() => errorState(), [])

    return (
      <TuiStoryPreview
        View={HealthView}
        app={HealthApp}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        {...createInteractiveProps({
          args,
          staticState: finalState,
          idleState: loadingState(),
          createTimeline: () => createErrorTimeline(),
        })}
      />
    )
  },
}
