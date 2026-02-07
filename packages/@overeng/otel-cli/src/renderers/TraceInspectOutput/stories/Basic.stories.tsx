/**
 * TraceInspect stories
 *
 * Storybook stories for the trace inspect command output.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { ALL_OUTPUT_TABS, TuiStoryPreview } from '@overeng/tui-react/storybook'

import { InspectApp } from '../app.ts'
import type { InspectState } from '../schema.ts'
import { InspectView } from '../view.tsx'
import {
  errorSpanTraceState,
  errorState,
  flatTraceState,
  loadingState,
  realisticTraceState,
  simpleTraceState,
} from './_fixtures.ts'

// =============================================================================
// Meta
// =============================================================================

type StoryArgs = {
  height: number
  tab: string
}

export default {
  title: 'otel-cli/TraceInspect',
  component: InspectView,
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
    height: 30,
    tab: 'tty',
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

// =============================================================================
// Story Helper
// =============================================================================

const createStory = (initialState: InspectState): Story => ({
  render: (args) => (
    <TuiStoryPreview
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
      defaultTab={args.tab as (typeof ALL_OUTPUT_TABS)[number]}
      app={InspectApp}
      View={InspectView}
      initialState={initialState}
    />
  ),
})

// =============================================================================
// Stories
// =============================================================================

/** Loading state while fetching trace data. */
export const Loading: Story = createStory(loadingState())

/** Simple trace with 3 spans. */
export const SimpleTrace: Story = createStory(simpleTraceState())

/** Realistic dt check:quick trace with nested project spans. */
export const RealisticTrace: Story = createStory(realisticTraceState())

/** Flat view of a trace (--flat flag). */
export const FlatView: Story = createStory(flatTraceState())

/** Trace containing error spans. */
export const ErrorSpans: Story = createStory(errorSpanTraceState())

/** Error state (e.g. trace not found). */
export const Error: Story = createStory(errorState())
