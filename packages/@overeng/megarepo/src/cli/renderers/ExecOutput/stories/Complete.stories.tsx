/**
 * Complete state stories for ExecOutput - various completion scenarios.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import type { ExecStateType } from '../mod.ts'
import { ExecApp } from '../mod.ts'
import { ExecView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

type StoryArgs = {
  verbose: boolean
}

export default {
  component: ExecView,
  title: 'CLI/Exec/Complete',
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component: 'Complete state views for the `mr exec` command.',
      },
    },
  },
  args: {
    verbose: false,
  },
  argTypes: {
    verbose: {
      description: 'Show verbose output',
      control: { type: 'boolean' },
    },
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

// Helper to create complete state with verbose override
const withVerbose = (_: { state: ExecStateType; verbose: boolean }): ExecStateType => {
  if (_.state._tag !== 'Complete') return _.state
  return { ..._.state, verbose: _.verbose }
}

/** All commands completed successfully */
export const CompleteSuccess: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={ExecView}
      app={ExecApp}
      initialState={withVerbose({ state: fixtures.completeSuccessState, verbose: args.verbose })}
    />
  ),
}

/** Mixed results - some success, some errors */
export const CompleteMixed: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={ExecView}
      app={ExecApp}
      initialState={withVerbose({ state: fixtures.completeMixedState, verbose: args.verbose })}
    />
  ),
}

/** Some members skipped */
export const CompleteWithSkipped: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={ExecView}
      app={ExecApp}
      initialState={withVerbose({
        state: fixtures.completeWithSkippedState,
        verbose: args.verbose,
      })}
    />
  ),
}

/** All commands failed */
export const CompleteAllErrors: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={ExecView}
      app={ExecApp}
      initialState={withVerbose({ state: fixtures.completeAllErrorsState, verbose: args.verbose })}
    />
  ),
}

/** Verbose output showing all details */
export const CompleteVerbose: Story = {
  args: {
    verbose: true,
  },
  render: (args) => (
    <TuiStoryPreview
      View={ExecView}
      app={ExecApp}
      initialState={withVerbose({ state: fixtures.completeVerboseState, verbose: args.verbose })}
    />
  ),
}
