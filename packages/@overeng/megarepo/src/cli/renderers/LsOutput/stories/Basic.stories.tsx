/**
 * Basic stories for LsOutput - common listing scenarios.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import type { OutputTab } from '@overeng/tui-react/storybook'
import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { LsApp } from '../mod.ts'
import { LsView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

const ALL_TABS: OutputTab[] = [
  'tty',
  'alt-screen',
  'ci',
  'ci-plain',
  'pipe',
  'log',
  'json',
  'ndjson',
]

type StoryArgs = {
  height: number
  all: boolean
}

export default {
  component: LsView,
  title: 'CLI/Ls/Basic',
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
      description: '--all flag: show nested megarepo members recursively',
      control: { type: 'boolean' },
    },
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

/** Default workspace listing */
export const Default: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={LsView}
      app={LsApp}
      initialState={fixtures.createDefaultState({ all: args.all })}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}

/** Single member in workspace */
export const SingleMember: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={LsView}
      app={LsApp}
      initialState={fixtures.createSingleMemberState({ all: args.all })}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}

/** Empty workspace - no members */
export const EmptyWorkspace: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={LsView}
      app={LsApp}
      initialState={fixtures.createEmptyState({ all: args.all })}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}

/** Large workspace with many members */
export const ManyMembers: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={LsView}
      app={LsApp}
      initialState={fixtures.createManyMembersState({ all: args.all })}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}

/** Workspace where all members are megarepos */
export const AllMegarepos: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={LsView}
      app={LsApp}
      initialState={fixtures.createAllMegareposState({ all: args.all })}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}
