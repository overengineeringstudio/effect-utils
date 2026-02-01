/**
 * Storybook stories for ExecOutput components.
 */

import { useAtom } from '@effect-atom/react'
import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { ExecView, ExecApp, type ExecViewProps, type ExecState } from './ExecOutput/mod.ts'

// =============================================================================
// Helper for stories with initial state
// =============================================================================

const ExecViewWithState = ({ initialState }: { initialState: ExecState }) => {
  const stateAtom = useAtom(() => initialState)
  return <ExecView stateAtom={stateAtom} />
}

// =============================================================================
// Example States
// =============================================================================

const errorState: ExecState = {
  _tag: 'Error',
  error: 'not_found',
  message: 'No megarepo.json found',
}

const memberNotFoundState: ExecState = {
  _tag: 'Error',
  error: 'not_found',
  message: 'Member not found',
}

const runningVerboseState: ExecState = {
  _tag: 'Running',
  command: 'npm version',
  mode: 'parallel',
  verbose: true,
  members: [
    { name: 'effect', status: 'running' },
    { name: 'effect-utils', status: 'pending' },
    { name: 'livestore', status: 'pending' },
  ],
}

const runningSequentialState: ExecState = {
  _tag: 'Running',
  command: 'git status',
  mode: 'sequential',
  verbose: true,
  members: [
    { name: 'effect', status: 'success', exitCode: 0, stdout: 'On branch main' },
    { name: 'effect-utils', status: 'running' },
  ],
}

const completeSuccessState: ExecState = {
  _tag: 'Complete',
  command: 'npm version',
  mode: 'parallel',
  verbose: false,
  hasErrors: false,
  members: [
    { name: 'effect', status: 'success', exitCode: 0, stdout: 'v3.0.0' },
    { name: 'effect-utils', status: 'success', exitCode: 0, stdout: 'v1.2.3' },
    { name: 'livestore', status: 'success', exitCode: 0, stdout: 'v0.5.0' },
  ],
}

const completeMixedState: ExecState = {
  _tag: 'Complete',
  command: 'npm version',
  mode: 'parallel',
  verbose: false,
  hasErrors: true,
  members: [
    { name: 'effect', status: 'success', exitCode: 0, stdout: 'v3.0.0' },
    { name: 'effect-utils', status: 'success', exitCode: 0, stdout: 'v1.2.3' },
    { name: 'livestore', status: 'error', exitCode: 1, stderr: 'Command failed: npm version' },
  ],
}

const completeWithSkippedState: ExecState = {
  _tag: 'Complete',
  command: 'npm install',
  mode: 'parallel',
  verbose: false,
  hasErrors: false,
  members: [
    { name: 'effect', status: 'success', exitCode: 0, stdout: 'added 125 packages in 2.3s' },
    { name: 'effect-utils', status: 'skipped', stderr: 'Member not synced' },
    { name: 'livestore', status: 'success', exitCode: 0, stdout: 'added 45 packages in 1.1s' },
  ],
}

const completeAllErrorsState: ExecState = {
  _tag: 'Complete',
  command: 'foo',
  mode: 'parallel',
  verbose: false,
  hasErrors: true,
  members: [
    { name: 'effect', status: 'error', exitCode: 1, stderr: 'Command not found: foo' },
    { name: 'effect-utils', status: 'error', exitCode: 1, stderr: 'Permission denied' },
    { name: 'livestore', status: 'error', exitCode: 127, stderr: 'sh: command not found' },
  ],
}

const completeVerboseState: ExecState = {
  _tag: 'Complete',
  command: 'npm version',
  mode: 'parallel',
  verbose: true,
  hasErrors: false,
  members: [
    { name: 'effect', status: 'success', exitCode: 0, stdout: 'v3.0.0' },
    { name: 'effect-utils', status: 'success', exitCode: 0, stdout: 'v1.2.3' },
  ],
}

// =============================================================================
// Meta
// =============================================================================

const meta = {
  title: 'CLI/Exec',
  component: ExecView,
  render: (args: { initialState: ExecState }) => (
    <TuiStoryPreview>
      <ExecViewWithState initialState={args.initialState} />
    </TuiStoryPreview>
  ),
  args: {
    initialState: errorState,
  },
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component: 'Output views for the `mr exec` command.',
      },
    },
  },
} satisfies Meta<{ initialState: ExecState }>

export default meta

type Story = StoryObj<typeof meta>

// =============================================================================
// Error Output Stories
// =============================================================================

export const NotInMegarepo: Story = {
  args: { initialState: errorState },
}

export const MemberNotFound: Story = {
  args: { initialState: memberNotFoundState },
}

// =============================================================================
// Running State Stories
// =============================================================================

export const RunningVerboseParallel: Story = {
  args: { initialState: runningVerboseState },
}

export const RunningVerboseSequential: Story = {
  args: { initialState: runningSequentialState },
}

// =============================================================================
// Complete State Stories
// =============================================================================

export const CompleteSuccess: Story = {
  args: { initialState: completeSuccessState },
}

export const CompleteMixed: Story = {
  args: { initialState: completeMixedState },
}

export const CompleteWithSkipped: Story = {
  args: { initialState: completeWithSkippedState },
}

export const CompleteAllErrors: Story = {
  args: { initialState: completeAllErrorsState },
}

export const CompleteVerbose: Story = {
  args: { initialState: completeVerboseState },
}
