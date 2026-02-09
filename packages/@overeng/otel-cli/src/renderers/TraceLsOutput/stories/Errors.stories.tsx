/**
 * Error stories for TraceLsOutput
 *
 * Storybook stories for the `otel trace ls` command - error scenarios.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { ALL_OUTPUT_TABS, TuiStoryPreview } from '@overeng/tui-react/storybook'

import { LsApp } from '../app.ts'
import { LsView } from '../view.tsx'
import { createErrorState } from './_fixtures.ts'

// =============================================================================
// Meta
// =============================================================================

type StoryArgs = {
  height: number
}

export default {
  component: LsView,
  title: 'otel-cli/TraceLs/Errors',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: 'Output for the `otel trace ls` command - error scenarios.',
      },
    },
  },
  args: {
    height: 400,
  },
  argTypes: {
    height: {
      description: 'Terminal height in pixels',
      control: { type: 'range', min: 200, max: 600, step: 50 },
    },
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

// =============================================================================
// Stories
// =============================================================================

/** Error: failed to connect to Grafana. */
export const Error: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={LsView}
      app={LsApp}
      initialState={createErrorState()}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}
