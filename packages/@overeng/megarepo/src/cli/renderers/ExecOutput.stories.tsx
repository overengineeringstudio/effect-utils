/**
 * Storybook stories for ExecOutput components.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { ExecView } from './ExecOutput/view.tsx'
import { ExecApp, type ExecStateType } from './ExecOutput/mod.ts'

// =============================================================================
// Example States
// =============================================================================

const errorState: ExecStateType = {
  _tag: 'Error',
  error: 'not_found',
  message: 'No megarepo.json found',
}

const memberNotFoundState: ExecStateType = {
  _tag: 'Error',
  error: 'not_found',
  message: 'Member not found',
}

const runningVerboseState: ExecStateType = {
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

const runningSequentialState: ExecStateType = {
  _tag: 'Running',
  command: 'git status',
  mode: 'sequential',
  verbose: true,
  members: [
    { name: 'effect', status: 'success', exitCode: 0, stdout: 'On branch main' },
    { name: 'effect-utils', status: 'running' },
  ],
}

const completeSuccessState: ExecStateType = {
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

const completeMixedState: ExecStateType = {
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

const completeWithSkippedState: ExecStateType = {
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

const completeAllErrorsState: ExecStateType = {
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

const completeVerboseState: ExecStateType = {
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
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component: 'Output views for the `mr exec` command.',
      },
    },
  },
} satisfies Meta<typeof ExecView>

export default meta

type Story = StoryObj<typeof ExecView>

// =============================================================================
// Error Output Stories
// =============================================================================

export const NotInMegarepo: Story = {
  render: () => (
    <TuiStoryPreview
      View={ExecView}
      app={ExecApp}
      initialState={errorState}
    />
  ),
}

export const MemberNotFound: Story = {
  render: () => (
    <TuiStoryPreview
      View={ExecView}
      app={ExecApp}
      initialState={memberNotFoundState}
    />
  ),
}

// =============================================================================
// Running State Stories
// =============================================================================

export const RunningVerboseParallel: Story = {
  render: () => (
    <TuiStoryPreview
      View={ExecView}
      app={ExecApp}
      initialState={runningVerboseState}
    />
  ),
}

export const RunningVerboseSequential: Story = {
  render: () => (
    <TuiStoryPreview
      View={ExecView}
      app={ExecApp}
      initialState={runningSequentialState}
    />
  ),
}

// =============================================================================
// Complete State Stories
// =============================================================================

export const CompleteSuccess: Story = {
  render: () => (
    <TuiStoryPreview
      View={ExecView}
      app={ExecApp}
      initialState={completeSuccessState}
    />
  ),
}

export const CompleteMixed: Story = {
  render: () => (
    <TuiStoryPreview
      View={ExecView}
      app={ExecApp}
      initialState={completeMixedState}
    />
  ),
}

export const CompleteWithSkipped: Story = {
  render: () => (
    <TuiStoryPreview
      View={ExecView}
      app={ExecApp}
      initialState={completeWithSkippedState}
    />
  ),
}

export const CompleteAllErrors: Story = {
  render: () => (
    <TuiStoryPreview
      View={ExecView}
      app={ExecApp}
      initialState={completeAllErrorsState}
    />
  ),
}

export const CompleteVerbose: Story = {
  render: () => (
    <TuiStoryPreview
      View={ExecView}
      app={ExecApp}
      initialState={completeVerboseState}
    />
  ),
}
