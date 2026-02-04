/**
 * Error state stories for ExecOutput.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import type { OutputTab } from '@overeng/tui-react/storybook'
import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { ExecApp } from '../mod.ts'
import { ExecView } from '../view.tsx'
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
      tabs={ALL_TABS}
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
      tabs={ALL_TABS}
    />
  ),
}
