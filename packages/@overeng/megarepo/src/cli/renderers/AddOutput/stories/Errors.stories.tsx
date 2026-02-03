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
} satisfies Meta

type Story = StoryObj

/** Error: not inside a megarepo */
export const ErrorNotInMegarepo: Story = {
  render: () => (
    <TuiStoryPreview
      View={AddView}
      app={AddApp}
      initialState={fixtures.createErrorNotInMegarepoState()}
      tabs={ALL_TABS}
    />
  ),
}

/** Error: invalid repository reference */
export const ErrorInvalidRepo: Story = {
  render: () => (
    <TuiStoryPreview
      View={AddView}
      app={AddApp}
      initialState={fixtures.createErrorInvalidRepoState()}
      tabs={ALL_TABS}
    />
  ),
}

/** Error: member already exists */
export const ErrorAlreadyExists: Story = {
  render: () => (
    <TuiStoryPreview
      View={AddView}
      app={AddApp}
      initialState={fixtures.createErrorAlreadyExistsState()}
      tabs={ALL_TABS}
    />
  ),
}
