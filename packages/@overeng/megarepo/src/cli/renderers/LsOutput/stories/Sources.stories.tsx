/**
 * Source type stories for LsOutput - local paths and error states.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import type { OutputTab } from '@overeng/tui-react/storybook'
import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { LsApp } from '../mod.ts'
import { LsView } from '../view.tsx'
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
  component: LsView,
  title: 'CLI/Ls/Sources',
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

/** Members with local filesystem paths as sources */
export const LocalPaths: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={LsView}
      app={LsApp}
      initialState={fixtures.createLocalPathsState()}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}

/** Error state - megarepo.json not found */
export const ErrorState: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={LsView}
      app={LsApp}
      initialState={fixtures.createErrorState()}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}
