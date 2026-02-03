/**
 * Result state stories for AddOutput - various success scenarios.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import type { OutputTab } from '@overeng/tui-react/storybook'
import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { AddApp } from '../mod.ts'
import { AddView } from '../view.tsx'
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

export default {
  component: AddView,
  title: 'CLI/Add/Results',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: 'Output for the `mr add` command - success scenarios.',
      },
    },
  },
} satisfies Meta

type Story = StoryObj

/** Simple add without sync */
export const AddSimple: Story = {
  render: () => (
    <TuiStoryPreview
      View={AddView}
      app={AddApp}
      initialState={fixtures.createSuccessState()}
      tabs={ALL_TABS}
    />
  ),
}

/** Add with sync - member cloned */
export const AddWithSync: Story = {
  render: () => (
    <TuiStoryPreview
      View={AddView}
      app={AddApp}
      initialState={fixtures.createSuccessSyncedState()}
      tabs={ALL_TABS}
    />
  ),
}

/** Add with sync - existing member synced */
export const AddWithSyncExisting: Story = {
  render: () => (
    <TuiStoryPreview
      View={AddView}
      app={AddApp}
      initialState={fixtures.createSuccessSyncedExistingState()}
      tabs={ALL_TABS}
    />
  ),
}

/** Add with sync - sync failed */
export const AddWithSyncError: Story = {
  render: () => (
    <TuiStoryPreview
      View={AddView}
      app={AddApp}
      initialState={fixtures.createSuccessSyncErrorState()}
      tabs={ALL_TABS}
    />
  ),
}
