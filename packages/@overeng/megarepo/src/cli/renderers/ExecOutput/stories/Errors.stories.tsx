/**
 * Error state stories for ExecOutput.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { ALL_OUTPUT_TABS, commonArgTypes, TuiStoryPreview } from '@overeng/tui-react/storybook'

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
    height: commonArgTypes.height,
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

export const NotInMegarepo: Story = {
  render: (args) => (
    <TuiStoryPreview
      cwd="~/workspace"
      command="mr exec"
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
      cwd="~/workspace"
      command="mr exec"
      View={ExecView}
      app={ExecApp}
      initialState={fixtures.memberNotFoundState}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}
