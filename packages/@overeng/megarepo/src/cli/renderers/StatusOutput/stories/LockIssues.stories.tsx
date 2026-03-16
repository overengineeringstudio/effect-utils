/**
 * Lock file related StatusOutput stories.
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
  title: 'CLI/Status/Lock Issues',
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

/** Lock file doesn't exist yet */
export const LockMissing: Story = {
  render: (args) => {
    const { initialState, cwd } = applyCwd({
      state: fixtures.createLockMissingState({ all: args.all }),
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

/** Lock file has missing/extra entries compared to megarepo.json */
export const LockStale: Story = {
  render: (args) => {
    const { initialState, cwd } = applyCwd({
      state: fixtures.createLockStaleState({ all: args.all }),
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

/** Lock ref is outdated but current state matches source intent */
export const StaleLockRef: Story = {
  render: (args) => {
    const { initialState, cwd } = applyCwd({
      state: fixtures.createStaleLockState({ all: args.all }),
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

/** Local commit differs from locked commit (inline indicator) */
export const CommitDrift: Story = {
  render: (args) => {
    const { initialState, cwd } = applyCwd({
      state: fixtures.createCommitDriftState({ all: args.all }),
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
