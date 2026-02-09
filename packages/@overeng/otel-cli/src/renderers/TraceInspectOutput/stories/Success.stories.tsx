/**
 * Success state stories for TraceInspect
 *
 * Demonstrates various successful trace inspection scenarios including:
 * - Simple trace with 3 spans
 * - Realistic nested trace with 12 spans
 * - Trace containing error-status spans
 *
 * All stories support the `--flat` flag via a boolean control and
 * `interactive` mode for animated timeline playback.
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
  title: 'otel-cli/TraceInspect/Success',
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

/** Simple trace with 3 spans. */
export const SimpleTrace: Story = {
  render: (args) => {
    const stateConfig = useMemo(() => ({ flat: args.flat }), [args.flat])

    return (
      <TuiStoryPreview
        View={InspectView}
        app={InspectApp}
        initialState={
          args.interactive ? fixtures.loadingState() : fixtures.simpleTraceState(stateConfig)
        }
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive ? { timeline: fixtures.createSimpleTimeline(stateConfig) } : {})}
      />
    )
  },
}

/** Realistic dt check:quick trace with nested project spans. */
export const RealisticTrace: Story = {
  render: (args) => {
    const stateConfig = useMemo(() => ({ flat: args.flat }), [args.flat])

    return (
      <TuiStoryPreview
        View={InspectView}
        app={InspectApp}
        initialState={
          args.interactive ? fixtures.loadingState() : fixtures.realisticTraceState(stateConfig)
        }
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive ? { timeline: fixtures.createRealisticTimeline(stateConfig) } : {})}
      />
    )
  },
}

/** Trace containing error-status spans (statusCode 2). */
export const ErrorSpans: Story = {
  render: (args) => {
    const stateConfig = useMemo(() => ({ flat: args.flat }), [args.flat])

    return (
      <TuiStoryPreview
        View={InspectView}
        app={InspectApp}
        initialState={
          args.interactive ? fixtures.loadingState() : fixtures.errorSpanTraceState(stateConfig)
        }
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive ? { timeline: fixtures.createErrorSpanTimeline(stateConfig) } : {})}
      />
    )
  },
}
