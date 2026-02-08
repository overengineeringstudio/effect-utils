/**
 * MetricsLs error stories
 *
 * Storybook stories for metrics ls command error and failure scenarios.
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

import { LsApp } from '../app.ts'
import { LsView } from '../view.tsx'
import { createErrorTimeline, errorState, loadingState } from './_fixtures.ts'

// =============================================================================
// Meta
// =============================================================================

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
}

export default {
  title: 'otel-cli/MetricsLs/Errors',
  component: LsView,
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

/** Connection error — OTEL stack unreachable. */
export const Error: Story = {
  render: (args) => {
    const finalState = useMemo(() => errorState(), [])

    return (
      <TuiStoryPreview
        View={LsView}
        app={LsApp}
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
