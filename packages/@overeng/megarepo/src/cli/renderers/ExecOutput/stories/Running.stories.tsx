/**
 * Running state stories for ExecOutput.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { ExecApp } from '../mod.ts'
import { ExecView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

type StoryArgs = {
  verbose: boolean
  mode: 'parallel' | 'sequential'
}

export default {
  component: ExecView,
  title: 'CLI/Exec/Running',
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component: 'Running state views for the `mr exec` command.',
      },
    },
  },
  args: {
    verbose: true,
    mode: 'parallel',
  },
  argTypes: {
    verbose: {
      description: 'Show verbose output',
      control: { type: 'boolean' },
    },
    mode: {
      description: 'Execution mode',
      control: { type: 'select' },
      options: ['parallel', 'sequential'],
    },
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

export const RunningVerboseParallel: Story = {
  args: {
    verbose: true,
    mode: 'parallel',
  },
  render: (args) => (
    <TuiStoryPreview
      View={ExecView}
      app={ExecApp}
      initialState={fixtures.createRunningState({ verbose: args.verbose, mode: args.mode })}
    />
  ),
}

export const RunningVerboseSequential: Story = {
  args: {
    verbose: true,
    mode: 'sequential',
  },
  render: (args) => (
    <TuiStoryPreview
      View={ExecView}
      app={ExecApp}
      initialState={fixtures.createRunningState({ verbose: args.verbose, mode: args.mode })}
    />
  ),
}
