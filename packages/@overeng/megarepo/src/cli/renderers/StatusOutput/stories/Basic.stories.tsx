/**
 * Basic StatusOutput stories - clean states, single member, empty workspace.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { ALL_OUTPUT_TABS, TuiStoryPreview } from '@overeng/tui-react/storybook'

import { StatusApp } from '../mod.ts'
import { StatusView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

type StoryArgs = {
  height: number
  all: boolean
}

export default {
  component: StatusView,
  title: 'CLI/Status/Basic',
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    height: 400,
    all: false,
  },
  argTypes: {
    height: {
      description: 'Terminal height in pixels',
      control: { type: 'range', min: 200, max: 600, step: 50 },
    },
    all: {
      description: '--all flag: show nested megarepos recursively',
      control: { type: 'boolean' },
    },
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

/** Default state with mixed member status */
export const Default: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createDefaultState({ all: args.all })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

/** All members clean, no issues */
export const AllClean: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createCleanState({ all: args.all })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

/** Workspace with single member */
export const SingleMember: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createSingleMemberState({ all: args.all })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

/** Empty workspace with no members */
export const EmptyWorkspace: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createEmptyWorkspaceState({ all: args.all })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}
