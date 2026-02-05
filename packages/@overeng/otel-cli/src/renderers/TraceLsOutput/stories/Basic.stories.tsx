/**
 * TraceLs stories
 *
 * Storybook stories for the trace ls command output.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { ALL_OUTPUT_TABS, TuiStoryPreview } from '@overeng/tui-react/storybook'

import { LsApp } from '../app.ts'
import type { LsState } from '../schema.ts'
import { LsView } from '../view.tsx'
import { defaultState, emptyState, errorState, filteredState, loadingState } from './_fixtures.ts'

// =============================================================================
// Meta
// =============================================================================

type StoryArgs = {
  height: number
  tab: string
}

export default {
  title: 'otel-cli/TraceLs',
  component: LsView,
  argTypes: {
    height: {
      control: { type: 'number', min: 10, max: 80 },
      description: 'Terminal height in rows',
    },
    tab: {
      control: 'select',
      options: ALL_OUTPUT_TABS,
      description: 'Output mode tab',
    },
  },
  args: {
    height: 20,
    tab: 'tty',
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

// =============================================================================
// Story Helper
// =============================================================================

const createStory = (initialState: LsState): Story => ({
  render: (args) => (
    <TuiStoryPreview
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
      defaultTab={args.tab as (typeof ALL_OUTPUT_TABS)[number]}
      app={LsApp}
      View={LsView}
      initialState={initialState}
    />
  ),
})

// =============================================================================
// Stories
// =============================================================================

/** Loading state. */
export const Loading: Story = createStory(loadingState())

/** Default trace listing. */
export const Default: Story = createStory(defaultState())

/** Empty results. */
export const Empty: Story = createStory(emptyState())

/** Filtered with a TraceQL query. */
export const Filtered: Story = createStory(filteredState())

/** Error state. */
export const Error: Story = createStory(errorState())
