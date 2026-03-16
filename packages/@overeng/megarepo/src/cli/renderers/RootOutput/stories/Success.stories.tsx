/**
 * Success state stories for RootOutput.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { ALL_OUTPUT_TABS, commonArgTypes, TuiStoryPreview } from '@overeng/tui-react/storybook'

import { RootApp } from '../mod.ts'
import { RootView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

type StoryArgs = {
  height: number
}

export default {
  component: RootView,
  title: 'CLI/Root/Success',
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    height: 400,
  },
  argTypes: {
    height: commonArgTypes.height,
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

export const Default: Story = {
  render: (args) => (
    <TuiStoryPreview
      cwd="~/workspace"
      command="mr"
      View={RootView}
      app={RootApp}
      initialState={fixtures.successState}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}
