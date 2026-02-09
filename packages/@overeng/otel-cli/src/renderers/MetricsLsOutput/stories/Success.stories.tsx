/**
 * MetricsLs success stories
 *
 * Storybook stories for successful metrics ls command output scenarios.
 * The `source` and `filter` controls let users explore collector vs tempo
 * data and name filtering without separate stories per variation.
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
import {
  COLLECTOR_METRIC_NAMES,
  COLLECTOR_METRICS,
  TEMPO_METRIC_NAMES,
  TEMPO_METRICS,
  createState,
  createTimeline,
  loadingState,
  type LsStateConfig,
} from './_fixtures.ts'

// =============================================================================
// Meta
// =============================================================================

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
  /** --source flag: 'collector' or 'tempo' */
  source: 'collector' | 'tempo'
  /** --filter flag: pattern filter for metric names */
  filter: string
}

export default {
  title: 'otel-cli/MetricsLs/Success',
  component: LsView,
  argTypes: {
    ...commonArgTypes,
    source: {
      description: '--source flag: metric source to query',
      control: 'select',
      options: ['collector', 'tempo'],
    },
    filter: {
      description: '--filter flag: pattern filter for metric names',
      control: 'text',
    },
  },
  args: {
    ...defaultStoryArgs,
    source: 'collector',
    filter: '',
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

// =============================================================================
// Stories
// =============================================================================

/** Default metrics listing — use `source` and `filter` controls to explore variations. */
export const Default: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      (): LsStateConfig => ({
        source: args.source,
        metrics: args.source === 'collector' ? COLLECTOR_METRICS : TEMPO_METRICS,
        metricNames: args.source === 'collector' ? COLLECTOR_METRIC_NAMES : TEMPO_METRIC_NAMES,
        ...(args.filter ? { filter: args.filter } : {}),
      }),
      [args.source, args.filter],
    )

    return (
      <TuiStoryPreview
        View={LsView}
        app={LsApp}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        {...createInteractiveProps({
          args,
          staticState: createState(stateConfig),
          idleState: loadingState(),
          createTimeline: () => createTimeline(stateConfig),
        })}
      />
    )
  },
}

/** Empty results — no metrics found. */
export const Empty: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      (): LsStateConfig => ({
        source: args.source,
        metrics: [],
        metricNames: [],
        ...(args.filter ? { filter: args.filter } : {}),
      }),
      [args.source, args.filter],
    )

    return (
      <TuiStoryPreview
        View={LsView}
        app={LsApp}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        {...createInteractiveProps({
          args,
          staticState: createState(stateConfig),
          idleState: loadingState(),
          createTimeline: () => createTimeline(stateConfig),
        })}
      />
    )
  },
}
