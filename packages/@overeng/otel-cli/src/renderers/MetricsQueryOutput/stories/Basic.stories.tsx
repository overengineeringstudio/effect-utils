/**
 * MetricsQuery stories
 *
 * Storybook stories for the metrics query command output.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { ALL_OUTPUT_TABS, TuiStoryPreview } from '@overeng/tui-react/storybook'

import { QueryApp } from '../app.ts'
import type { QueryState } from '../schema.ts'
import { QueryView } from '../view.tsx'
import {
  connectionErrorState,
  emptyState,
  errorState,
  groupedQueryState,
  histogramQueryState,
  loadingState,
  longRangeState,
  rateQueryState,
} from './_fixtures.ts'

// =============================================================================
// Meta
// =============================================================================

type StoryArgs = {
  height: number
  tab: string
}

export default {
  title: 'otel-cli/MetricsQuery',
  component: QueryView,
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
    height: 25,
    tab: 'tty',
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

// =============================================================================
// Story Helper
// =============================================================================

const createStory = (initialState: QueryState): Story => ({
  render: (args) => (
    <TuiStoryPreview
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
      defaultTab={args.tab as (typeof ALL_OUTPUT_TABS)[number]}
      app={QueryApp}
      View={QueryView}
      initialState={initialState}
    />
  ),
})

// =============================================================================
// Stories
// =============================================================================

/** Loading state. */
export const Loading: Story = createStory(loadingState())

/** Simple rate query. */
export const RateQuery: Story = createStory(rateQueryState())

/** Grouped by service name. */
export const GroupedByService: Story = createStory(groupedQueryState())

/** Histogram with quantiles. */
export const Histogram: Story = createStory(histogramQueryState())

/** Long time range (24h). */
export const LongRange: Story = createStory(longRangeState())

/** Empty results. */
export const Empty: Story = createStory(emptyState())

/** Invalid query error. */
export const InvalidQueryError: Story = createStory(errorState())

/** Connection error. */
export const ConnectionError: Story = createStory(connectionErrorState())
