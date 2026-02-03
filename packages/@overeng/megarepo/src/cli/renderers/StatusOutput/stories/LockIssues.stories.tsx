/**
 * Lock file related StatusOutput stories.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { StatusApp } from '../mod.ts'
import { StatusView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

export default {
  component: StatusView,
  title: 'CLI/Status/Lock Issues',
  parameters: {
    layout: 'padded',
  },
} satisfies Meta

type Story = StoryObj<typeof StatusView>

/** Lock file doesn't exist yet */
export const LockMissing: Story = {
  render: () => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createLockMissingState()}
    />
  ),
}

/** Lock file has missing/extra entries compared to megarepo.json */
export const LockStale: Story = {
  render: () => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createLockStaleState()}
    />
  ),
}

/** Lock ref is outdated but current state matches source intent */
export const StaleLockRef: Story = {
  render: () => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createStaleLockState()}
    />
  ),
}

/** Local commit differs from locked commit (inline indicator) */
export const CommitDrift: Story = {
  render: () => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createCommitDriftState()}
    />
  ),
}
