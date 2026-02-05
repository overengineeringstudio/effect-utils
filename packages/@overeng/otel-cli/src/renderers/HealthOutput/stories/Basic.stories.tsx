/**
 * Health stories
 *
 * Storybook stories for the health command output.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { ALL_OUTPUT_TABS, TuiStoryPreview } from '@overeng/tui-react/storybook'

import { HealthApp } from '../app.ts'
import type { HealthState } from '../schema.ts'
import { HealthView } from '../view.tsx'
import {
  allHealthyState,
  allUnhealthyState,
  errorState,
  loadingState,
  partiallyUnhealthyState,
} from './_fixtures.ts'

// =============================================================================
// Meta
// =============================================================================

type StoryArgs = {
  height: number
  tab: string
}

export default {
  title: 'otel-cli/Health',
  component: HealthView,
  argTypes: {
    height: {
      control: { type: 'number', min: 10, max: 40 },
      description: 'Terminal height in rows',
    },
    tab: {
      control: 'select',
      options: ALL_OUTPUT_TABS,
      description: 'Output mode tab',
    },
  },
  args: {
    height: 15,
    tab: 'tty',
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

// =============================================================================
// Story Helper
// =============================================================================

const createStory = (initialState: HealthState): Story => ({
  render: (args) => (
    <TuiStoryPreview
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
      defaultTab={args.tab as (typeof ALL_OUTPUT_TABS)[number]}
      app={HealthApp}
      View={HealthView}
      initialState={initialState}
    />
  ),
})

// =============================================================================
// Stories
// =============================================================================

/** Loading state. */
export const Loading: Story = createStory(loadingState())

/** All components healthy. */
export const AllHealthy: Story = createStory(allHealthyState())

/** Some components unhealthy. */
export const PartiallyUnhealthy: Story = createStory(partiallyUnhealthyState())

/** All components down. */
export const AllUnhealthy: Story = createStory(allUnhealthyState())

/** Error state. */
export const Error: Story = createStory(errorState())
