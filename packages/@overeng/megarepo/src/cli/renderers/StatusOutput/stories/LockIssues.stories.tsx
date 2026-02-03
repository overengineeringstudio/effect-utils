/**
 * Lock file related StatusOutput stories.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import type { OutputTab } from '@overeng/tui-react/storybook'
import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { StatusApp } from '../mod.ts'
import { StatusView } from '../view.tsx'
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
  component: StatusView,
  title: 'CLI/Status/Lock Issues',
  parameters: {
    layout: 'padded',
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
      description: '--all flag: show nested megarepos recursively',
      control: { type: 'boolean' },
    },
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

/** Lock file doesn't exist yet */
export const LockMissing: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createLockMissingState({ all: args.all })}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}

/** Lock file has missing/extra entries compared to megarepo.json */
export const LockStale: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createLockStaleState({ all: args.all })}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}

/** Lock ref is outdated but current state matches source intent */
export const StaleLockRef: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createStaleLockState({ all: args.all })}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}

/** Local commit differs from locked commit (inline indicator) */
export const CommitDrift: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createCommitDriftState({ all: args.all })}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}
