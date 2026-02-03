/**
 * Warning stories for PinOutput - non-blocking issues.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import type { OutputTab } from '@overeng/tui-react/storybook'
import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { PinApp } from '../mod.ts'
import { PinView } from '../view.tsx'
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
  component: PinView,
  title: 'CLI/Pin/Warnings',
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

/** Warning: Worktree for pinned ref not available */
export const WarningWorktreeNotAvailable: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={PinView}
      app={PinApp}
      initialState={fixtures.createWarningWorktreeNotAvailable()}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}

/** Warning: Member was removed from config */
export const WarningMemberRemovedFromConfig: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={PinView}
      app={PinApp}
      initialState={fixtures.createWarningMemberRemovedFromConfig()}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}
