/**
 * Success state stories for RootOutput.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { ALL_OUTPUT_TABS, TuiStoryPreview } from '@overeng/tui-react/storybook'

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
    height: {
      description: 'Terminal height in pixels',
      control: { type: 'range', min: 200, max: 600, step: 50 },
    },
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

export const Default: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={RootView}
      app={RootApp}
      initialState={fixtures.successState}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}
