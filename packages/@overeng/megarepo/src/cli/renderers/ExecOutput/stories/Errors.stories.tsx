/**
 * Error state stories for ExecOutput.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { ALL_OUTPUT_TABS, TuiStoryPreview } from '@overeng/tui-react/storybook'

import { ExecApp } from '../mod.ts'
import { ExecView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

type StoryArgs = {
  height: number
}

export default {
  component: ExecView,
  title: 'CLI/Exec/Errors',
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

export const NotInMegarepo: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={ExecView}
      app={ExecApp}
      initialState={fixtures.errorState}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

export const MemberNotFound: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={ExecView}
      app={ExecApp}
      initialState={fixtures.memberNotFoundState}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}
