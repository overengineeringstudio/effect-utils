/**
 * Basic stories for LsOutput - common listing scenarios.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { ALL_OUTPUT_TABS, commonArgTypes, TuiStoryPreview } from '@overeng/tui-react/storybook'

import { applyCwd, cwdArgType, flagArgTypes, MEMBERS } from '../../_story-constants.ts'
import { LsApp } from '../mod.ts'
import { LsView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

type StoryArgs = {
  height: number
  all: boolean
  cwd: string
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
    cwd: '(root)',
  },
  argTypes: {
    height: commonArgTypes.height,
    all: flagArgTypes.all,
    cwd: cwdArgType,
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

/** Default workspace listing */
export const Default: Story = {
  render: (args) => {
    const { initialState, cwd } = applyCwd({
      state: fixtures.createDefaultState({ all: args.all }),
      cwdArg: args.cwd,
    })
    return (
      <TuiStoryPreview
        View={LsView}
        app={LsApp}
        initialState={initialState}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        command="mr ls"
        cwd={cwd}
      />
    )
  },
}

/** Single member in workspace */
export const SingleMember: Story = {
  render: (args) => {
    const { initialState, cwd } = applyCwd({
      state: fixtures.createSingleMemberState({ all: args.all }),
      cwdArg: args.cwd,
    })
    return (
      <TuiStoryPreview
        View={LsView}
        app={LsApp}
        initialState={initialState}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        command="mr ls"
        cwd={cwd}
      />
    )
  },
}

/** Empty workspace - no members */
export const EmptyWorkspace: Story = {
  render: (args) => {
    const { initialState, cwd } = applyCwd({
      state: fixtures.createEmptyState({ all: args.all }),
      cwdArg: args.cwd,
    })
    return (
      <TuiStoryPreview
        View={LsView}
        app={LsApp}
        initialState={initialState}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        command="mr ls"
        cwd={cwd}
      />
    )
  },
}

/** Large workspace with many members */
export const ManyMembers: Story = {
  render: (args) => {
    const { initialState, cwd } = applyCwd({
      state: fixtures.createManyMembersState({ all: args.all }),
      cwdArg: args.cwd,
    })
    return (
      <TuiStoryPreview
        View={LsView}
        app={LsApp}
        initialState={initialState}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        command="mr ls"
        cwd={cwd}
      />
    )
  },
}

/** Current location scope dimming — toggle --all to disable dimming */
export const CurrentLocation: Story = {
  args: { cwd: MEMBERS.devTools },
  render: (args) => {
    const { initialState, cwd } = applyCwd({
      state: fixtures.createCurrentLocationState({ all: args.all }),
      cwdArg: args.cwd,
    })
    return (
      <TuiStoryPreview
        View={LsView}
        app={LsApp}
        initialState={initialState}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        command={args.all === true ? 'mr ls --all' : 'mr ls'}
        cwd={cwd}
      />
    )
  },
}

/** Workspace where all members are megarepos */
export const AllMegarepos: Story = {
  render: (args) => {
    const { initialState, cwd } = applyCwd({
      state: fixtures.createAllMegareposState({ all: args.all }),
      cwdArg: args.cwd,
    })
    return (
      <TuiStoryPreview
        View={LsView}
        app={LsApp}
        initialState={initialState}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        command="mr ls --all"
        cwd={cwd}
      />
    )
  },
}
