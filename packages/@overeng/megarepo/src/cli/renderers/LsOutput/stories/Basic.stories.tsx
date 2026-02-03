/**
 * Basic stories for LsOutput - common listing scenarios.
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
  title: 'CLI/Ls/Basic',
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    all: false,
  },
  argTypes: {
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
    />
  ),
}
