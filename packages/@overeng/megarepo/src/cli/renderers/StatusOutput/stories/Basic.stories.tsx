/**
 * Basic StatusOutput stories - clean states, single member, empty workspace.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { ALL_OUTPUT_TABS, commonArgTypes, TuiStoryPreview } from '@overeng/tui-react/storybook'

import { applyCwd, cwdArgType, flagArgTypes } from '../../_story-constants.ts'
import { StatusApp } from '../mod.ts'
import { StatusView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

type StoryArgs = {
  height: number
  all: boolean
  cwd: string
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
    cwd: '(root)',
  },
  argTypes: {
    height: commonArgTypes.height,
    all: flagArgTypes.all,
    cwd: cwdArgType,
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

/** Default state with mixed member status */
export const Default: Story = {
  render: (args) => {
    const { initialState, cwd } = applyCwd({
      state: fixtures.createDefaultState({ all: args.all }),
      cwdArg: args.cwd,
    })
    return (
      <TuiStoryPreview
        View={StatusView}
        app={StatusApp}
        initialState={initialState}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        command="mr status"
        cwd={cwd}
      />
    )
  },
}

/** All members clean, no issues */
export const AllClean: Story = {
  render: (args) => {
    const { initialState, cwd } = applyCwd({
      state: fixtures.createCleanState({ all: args.all }),
      cwdArg: args.cwd,
    })
    return (
      <TuiStoryPreview
        View={StatusView}
        app={StatusApp}
        initialState={initialState}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        command="mr status"
        cwd={cwd}
      />
    )
  },
}

/** Workspace with single member */
export const SingleMember: Story = {
  render: (args) => {
    const { initialState, cwd } = applyCwd({
      state: fixtures.createSingleMemberState({ all: args.all }),
      cwdArg: args.cwd,
    })
    return (
      <TuiStoryPreview
        View={StatusView}
        app={StatusApp}
        initialState={initialState}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        command="mr status"
        cwd={cwd}
      />
    )
  },
}

/** Empty workspace with no members */
export const EmptyWorkspace: Story = {
  render: (args) => {
    const { initialState, cwd } = applyCwd({
      state: fixtures.createEmptyWorkspaceState({ all: args.all }),
      cwdArg: args.cwd,
    })
    return (
      <TuiStoryPreview
        View={StatusView}
        app={StatusApp}
        initialState={initialState}
        height={args.height}
        tabs={ALL_OUTPUT_TABS}
        command="mr status"
        cwd={cwd}
      />
    )
  },
}
