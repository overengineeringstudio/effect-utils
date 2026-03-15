/**
 * Basic stories for LsOutput - common listing scenarios.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { ALL_OUTPUT_TABS, commonArgTypes, TuiStoryPreview } from '@overeng/tui-react/storybook'

import { flagArgTypes } from '../../_story-constants.ts'
import { LsApp } from '../mod.ts'
import { LsView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

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
    height: commonArgTypes.height,
    all: flagArgTypes.all,
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
      tabs={ALL_OUTPUT_TABS}
      command="mr ls"
      cwd="~/workspace"
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
      tabs={ALL_OUTPUT_TABS}
      command="mr ls"
      cwd="~/minimal"
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
      tabs={ALL_OUTPUT_TABS}
      command="mr ls"
      cwd="~/empty-workspace"
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
      tabs={ALL_OUTPUT_TABS}
      command="mr ls"
      cwd="~/large-workspace"
    />
  ),
}

/** Current location scope dimming — toggle --all to disable dimming */
export const CurrentLocation: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={LsView}
      app={LsApp}
      initialState={fixtures.createCurrentLocationState({ all: args.all })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
      command={args.all ? 'mr ls --all' : 'mr ls'}
      cwd="~/workspace"
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
      tabs={ALL_OUTPUT_TABS}
      command="mr ls --all"
      cwd="~/all-megarepos"
    />
  ),
}
