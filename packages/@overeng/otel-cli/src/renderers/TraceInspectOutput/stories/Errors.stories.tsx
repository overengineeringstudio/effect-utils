/**
 * Error state stories for TraceInspect
 *
 * Demonstrates error scenarios where the trace inspection itself failed,
 * e.g. trace not found in Tempo.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useMemo } from 'react'

import {
  ALL_OUTPUT_TABS,
  commonArgTypes,
  defaultStoryArgs,
  TuiStoryPreview,
} from '@overeng/tui-react/storybook'

import { InspectApp } from '../app.ts'
import { InspectView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

// =============================================================================
// Meta
// =============================================================================

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
  flat: boolean
}

export default {
  component: InspectView,
  title: 'otel-cli/TraceInspect/Errors',
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    ...defaultStoryArgs,
    flat: false,
  },
  argTypes: {
    ...commonArgTypes,
    flat: {
      description: '--flat flag: show flat span list instead of tree',
      control: { type: 'boolean' },
    },
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

// =============================================================================
// Stories
// =============================================================================

/** Loading state while fetching trace data. */
export const Loading: Story = {
  // Loading is a transient state — interactive and flat don't apply
  args: {
    interactive: false,
  },
  argTypes: {
    interactive: {
      control: false,
    },
    playbackSpeed: {
      control: false,
    },
    flat: {
      control: false,
    },
  },
  render: (args) => {
    const stateConfig = useMemo(() => fixtures.loadingState(), [])

    return (
      <TuiStoryPreview
        View={InspectView}
        app={InspectApp}
        initialState={stateConfig}
        height={args.height}
        autoRun={false}
        tabs={ALL_OUTPUT_TABS}
      />
    )
  },
}

/** Error state — trace not found in Tempo. */
export const Error: Story = {
  // Error is a terminal state — interactive and flat don't apply
  args: {
    interactive: false,
  },
  argTypes: {
    interactive: {
      control: false,
    },
    playbackSpeed: {
      control: false,
    },
    flat: {
      control: false,
    },
  },
  render: (args) => {
    const stateConfig = useMemo(() => fixtures.errorState(), [])

    return (
      <TuiStoryPreview
        View={InspectView}
        app={InspectApp}
        initialState={stateConfig}
        height={args.height}
        autoRun={false}
        tabs={ALL_OUTPUT_TABS}
      />
    )
  },
}
