/**
 * MetricsQuery success stories
 *
 * Storybook stories for successful `otel metrics query` command output scenarios.
 * Covers rate queries, grouped series, histograms, and empty results.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useMemo } from 'react'

import {
  ALL_OUTPUT_TABS,
  TuiStoryPreview,
  commonArgTypes,
  defaultStoryArgs,
} from '@overeng/tui-react/storybook'

import { QueryApp } from '../app.ts'
import { QueryView } from '../view.tsx'
import {
  type RangeKey,
  type StateConfig,
  createState,
  createTimeline,
  groupedQueryConfig,
  histogramQueryConfig,
  loadingState,
  rateQueryConfig,
} from './_fixtures.ts'

// =============================================================================
// Meta
// =============================================================================

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
  // CLI flags
  range: RangeKey
  step: number
}

export default {
  title: 'otel-cli/MetricsQuery/Success',
  component: QueryView,
  argTypes: {
    ...commonArgTypes,
    range: {
      description: '--range flag: preset time range',
      control: 'select',
      options: ['1h', '6h', '24h', '7d'],
    },
    step: {
      description: '--step flag: query step in seconds (default depends on range)',
      control: { type: 'number' },
    },
  },
  args: {
    ...defaultStoryArgs,
    range: '1h',
    step: 60,
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

// =============================================================================
// Helpers
// =============================================================================

/** Merge story args into a base scenario config. */
const withArgs = (_: { base: StateConfig; args: StoryArgs }): StateConfig => ({
  ..._.base,
  range: _.args.range,
  step: _.args.step,
})

// =============================================================================
// Stories
// =============================================================================

/** Simple rate query with a single series. */
export const RateQuery: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => withArgs({ base: rateQueryConfig, args }),
      [args.range, args.step],
    )

    return (
      <TuiStoryPreview
        View={QueryView}
        app={QueryApp}
        initialState={args.interactive ? loadingState() : createState(stateConfig)}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive ? { timeline: createTimeline(stateConfig) } : {})}
      />
    )
  },
}

/** Multiple series grouped by service name. */
export const GroupedByService: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => withArgs({ base: groupedQueryConfig, args }),
      [args.range, args.step],
    )

    return (
      <TuiStoryPreview
        View={QueryView}
        app={QueryApp}
        initialState={args.interactive ? loadingState() : createState(stateConfig)}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive ? { timeline: createTimeline(stateConfig) } : {})}
      />
    )
  },
}

/** Histogram query with p50/p95/p99 quantiles. */
export const Histogram: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => withArgs({ base: histogramQueryConfig, args }),
      [args.range, args.step],
    )

    return (
      <TuiStoryPreview
        View={QueryView}
        app={QueryApp}
        initialState={args.interactive ? loadingState() : createState(stateConfig)}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive ? { timeline: createTimeline(stateConfig) } : {})}
      />
    )
  },
}

/** Empty results - no matching series found. */
export const Empty: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      (): StateConfig => ({
        range: args.range,
        step: args.step,
        query: '{service.name="nonexistent"} | rate()',
        series: [],
      }),
      [args.range, args.step],
    )

    return (
      <TuiStoryPreview
        View={QueryView}
        app={QueryApp}
        initialState={args.interactive ? loadingState() : createState(stateConfig)}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive ? { timeline: createTimeline(stateConfig) } : {})}
      />
    )
  },
}
