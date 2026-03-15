/**
 * Working tree related StatusOutput stories.
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
  title: 'CLI/Status/Worktree Issues',
  parameters: {
    layout: 'padded',
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

/** All members have uncommitted changes */
export const AllDirty: Story = {
  render: (args) => {
    const { initialState, cwd } = applyCwd({
      state: fixtures.createAllDirtyState({ all: args.all }),
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

/** All members need sync (no worktrees exist) */
export const AllNotSynced: Story = {
  render: (args) => {
    const { initialState, cwd } = applyCwd({
      state: fixtures.createAllNotSyncedState({ all: args.all }),
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

/** Mixed warnings (dirty, not synced, unpushed) */
export const WithWarnings: Story = {
  render: (args) => {
    const { initialState, cwd } = applyCwd({
      state: fixtures.createWarningsState({ all: args.all }),
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
