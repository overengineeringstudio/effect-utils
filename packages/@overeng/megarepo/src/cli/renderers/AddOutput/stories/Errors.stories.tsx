/**
 * Error state stories for AddOutput - various error scenarios.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useMemo } from 'react'

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
  repo: string
  name: string
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
    repo: 'not-a-valid-repo',
    name: 'effect',
  },
  argTypes: {
    height: {
      description: 'Terminal height in pixels',
      control: { type: 'range', min: 200, max: 600, step: 50 },
    },
    repo: {
      description: 'Repository reference that triggers the error',
      control: { type: 'text' },
    },
    name: {
      description: '--name flag: member name that triggers the error',
      control: { type: 'text' },
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
  render: (args) => {
    const state = useMemo(() => fixtures.createErrorInvalidRepoState(args.repo), [args.repo])
    return (
      <TuiStoryPreview
        View={AddView}
        app={AddApp}
        initialState={state}
        height={args.height}
        tabs={ALL_TABS}
      />
    )
  },
}

/** Error: member already exists */
export const ErrorAlreadyExists: Story = {
  render: (args) => {
    const state = useMemo(() => fixtures.createErrorAlreadyExistsState(args.name), [args.name])
    return (
      <TuiStoryPreview
        View={AddView}
        app={AddApp}
        initialState={state}
        height={args.height}
        tabs={ALL_TABS}
      />
    )
  },
}
