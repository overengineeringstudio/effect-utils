/**
 * Ref tracking related StatusOutput stories.
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
  title: 'CLI/Status/Ref Issues',
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

/** Lock/symlink track different ref than source specifies */
export const SymlinkDrift: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createSymlinkDriftState({ all: args.all })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
      command="mr status"
      cwd="~/my-megarepo"
    />
  ),
}

/** Multiple members with symlink drift */
export const MultipleSymlinkDrift: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createMultipleSymlinkDriftState({ all: args.all })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
      command="mr status"
      cwd="~/my-megarepo"
    />
  ),
}

/** Git HEAD differs from store path ref (Issue #88) */
export const RefMismatch: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={fixtures.createRefMismatchState({ all: args.all })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
      command="mr status"
      cwd="~/my-megarepo"
    />
  ),
}
