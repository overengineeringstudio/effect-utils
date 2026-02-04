/**
 * Nested member stories for LsOutput - hierarchical workspace scenarios.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { ALL_OUTPUT_TABS, TuiStoryPreview } from '@overeng/tui-react/storybook'

import { LsApp } from '../mod.ts'
import { LsView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

type StoryArgs = {
  height: number
  all: boolean
}

export default {
  component: LsView,
  title: 'CLI/Ls/Nested',
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    height: 400,
    all: true,
  },
  argTypes: {
    height: {
      description: 'Terminal height in pixels',
      control: { type: 'range', min: 200, max: 600, step: 50 },
    },
    all: {
      description: '--all flag: show nested megarepo members recursively',
      control: { type: 'boolean' },
    },
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

/** Nested members with --all flag */
export const WithAllFlag: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={LsView}
      app={LsApp}
      initialState={fixtures.createWithAllFlagState({ all: args.all })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

/** Deeply nested hierarchy (3+ levels) */
export const DeeplyNested: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={LsView}
      app={LsApp}
      initialState={fixtures.createDeeplyNestedState({ all: args.all })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}
