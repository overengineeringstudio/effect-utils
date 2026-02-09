/**
 * MetricsQuery error stories
 *
 * Storybook stories for `otel metrics query` command error scenarios.
 * Covers invalid query syntax and connection failures.
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

import { QueryApp } from '../app.ts'
import { QueryView } from '../view.tsx'
import {
  createConnectionError,
  createConnectionErrorTimeline,
  createInvalidQueryError,
  createInvalidQueryErrorTimeline,
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
  title: 'otel-cli/MetricsQuery/Errors',
  component: QueryView,
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

/** Invalid TraceQL query syntax. */
export const InvalidQueryError: Story = {
  render: (args) => {
    const finalState = useMemo(() => createInvalidQueryError(), [])

    return (
      <TuiStoryPreview
        View={QueryView}
        app={QueryApp}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        {...createInteractiveProps({
          args,
          staticState: finalState,
          idleState: loadingState(),
          createTimeline: () => createInvalidQueryErrorTimeline(),
        })}
      />
    )
  },
}

/** Connection failure - Tempo backend unreachable. */
export const ConnectionError: Story = {
  render: (args) => {
    const finalState = useMemo(() => createConnectionError(), [])

    return (
      <TuiStoryPreview
        View={QueryView}
        app={QueryApp}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        {...createInteractiveProps({
          args,
          staticState: finalState,
          idleState: loadingState(),
          createTimeline: () => createConnectionErrorTimeline(),
        })}
      />
    )
  },
}
