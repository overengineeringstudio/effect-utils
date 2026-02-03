/**
 * Working tree related StatusOutput stories.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { StatusApp } from '../mod.ts'
import { StatusView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

export default {
  component: StatusView,
  title: 'CLI/Status/Worktree Issues',
  parameters: {
    layout: 'padded',
  },
} satisfies Meta

type Story = StoryObj<typeof StatusView>

/** All members have uncommitted changes */
export const AllDirty: Story = {
  render: () => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createAllDirtyState()}
    />
  ),
}

/** All members need sync (no worktrees exist) */
export const AllNotSynced: Story = {
  render: () => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createAllNotSyncedState()}
    />
  ),
}

/** Mixed warnings (dirty, not synced, unpushed) */
export const WithWarnings: Story = {
  render: () => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createWarningsState()}
    />
  ),
}
