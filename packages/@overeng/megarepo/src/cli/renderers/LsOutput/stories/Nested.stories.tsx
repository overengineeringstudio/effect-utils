/**
 * Nested member stories for LsOutput - hierarchical workspace scenarios.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { LsApp } from '../mod.ts'
import { LsView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

type StoryArgs = {
  all: boolean
}

export default {
  component: LsView,
  title: 'CLI/Ls/Nested',
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    all: true,
  },
  argTypes: {
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
    />
  ),
}
