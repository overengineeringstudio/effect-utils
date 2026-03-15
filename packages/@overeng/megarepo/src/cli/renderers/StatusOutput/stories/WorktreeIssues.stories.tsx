/**
 * Working tree related StatusOutput stories.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { ALL_OUTPUT_TABS, commonArgTypes, TuiStoryPreview } from '@overeng/tui-react/storybook'

import { flagArgTypes } from '../../_story-constants.ts'
import { StatusApp } from '../mod.ts'
import { StatusView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

type StoryArgs = {
  height: number
  all: boolean
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
  },
  argTypes: {
    height: commonArgTypes.height,
    all: flagArgTypes.all,
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

/** All members have uncommitted changes */
export const AllDirty: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createAllDirtyState({ all: args.all })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
      command="mr status"
      cwd="~/workspace"
    />
  ),
}

/** All members need sync (no worktrees exist) */
export const AllNotSynced: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createAllNotSyncedState({ all: args.all })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
      command="mr status"
      cwd="~/new-workspace"
    />
  ),
}

/** Mixed warnings (dirty, not synced, unpushed) */
export const WithWarnings: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createWarningsState({ all: args.all })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
      command="mr status"
      cwd="~/workspace"
    />
  ),
}
