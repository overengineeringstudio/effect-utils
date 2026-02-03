/**
 * Error state stories for AddOutput - various error scenarios.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import type { OutputTab } from '@overeng/tui-react/storybook'
import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { AddApp } from '../mod.ts'
import { AddView } from '../view.tsx'
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
  component: AddView,
  title: 'CLI/Add/Errors',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: 'Output for the `mr add` command - error scenarios.',
      },
    },
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

/** Error: not inside a megarepo */
export const ErrorNotInMegarepo: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={AddView}
      app={AddApp}
      initialState={fixtures.createErrorNotInMegarepoState()}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}

/** Error: invalid repository reference */
export const ErrorInvalidRepo: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={AddView}
      app={AddApp}
      initialState={fixtures.createErrorInvalidRepoState()}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}

/** Error: member already exists */
export const ErrorAlreadyExists: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={AddView}
      app={AddApp}
      initialState={fixtures.createErrorAlreadyExistsState()}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}
