/**
 * Success stories for TraceLsOutput
 *
 * Storybook stories for the `otel trace ls` command - success scenarios.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useMemo } from 'react'

import {
  ALL_OUTPUT_TABS,
  commonArgTypes,
  defaultStoryArgs,
  TuiStoryPreview,
} from '@overeng/tui-react/storybook'

import { LsApp } from '../app.ts'
import { LsView } from '../view.tsx'
import { createState, createTimeline, exampleTraces, loadingState } from './_fixtures.ts'

// =============================================================================
// Meta
// =============================================================================

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
  // CLI flags
  query: string
  limit: number
  all: boolean
}

export default {
  component: LsView,
  title: 'otel-cli/TraceLs/Success',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: 'Output for the `otel trace ls` command - success scenarios.',
      },
    },
  },
  args: {
    ...defaultStoryArgs,
    query: '',
    limit: 10,
    all: false,
  },
  argTypes: {
    ...commonArgTypes,
    query: {
      description: '--query flag: TraceQL query filter',
      control: { type: 'text' },
    },
    limit: {
      description: '--limit flag: max traces to return (default 10)',
      control: { type: 'number' },
    },
    all: {
      description: '--all flag: include internal Tempo traces',
      control: { type: 'boolean' },
    },
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

// =============================================================================
// Stories
// =============================================================================

/** Default trace listing with typical results. */
export const Default: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        query: args.query || undefined,
        limit: args.limit,
        all: args.all,
        traces: exampleTraces,
      }),
      [args.query, args.limit, args.all],
    )
    return (
      <TuiStoryPreview
        View={LsView}
        app={LsApp}
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

/** Empty results - no traces found. */
export const Empty: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        query: args.query || undefined,
        limit: args.limit,
        all: args.all,
        traces: [],
      }),
      [args.query, args.limit, args.all],
    )
    return (
      <TuiStoryPreview
        View={LsView}
        app={LsApp}
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

/** Filtered results with a pre-filled TraceQL query. */
export const Filtered: Story = {
  args: {
    query: '{resource.service.name="dt"}',
  },
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        query: args.query || undefined,
        limit: args.limit,
        all: args.all,
        traces: [exampleTraces[0]!],
      }),
      [args.query, args.limit, args.all],
    )
    return (
      <TuiStoryPreview
        View={LsView}
        app={LsApp}
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
