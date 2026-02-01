/**
 * Storybook stories for PinOutput component.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { PinApp, PinState } from './PinOutput/mod.ts'
import { PinView } from './PinOutput/view.tsx'

// =============================================================================
// State Factories
// =============================================================================

const createIdleState = (): typeof PinState.Type => ({ _tag: 'Idle' })

const createPinSuccessWithRef = (): typeof PinState.Type => ({
  _tag: 'Success',
  member: 'effect',
  action: 'pin',
  ref: 'v3.0.0',
  commit: 'abc1234def5678',
})

const createPinSuccessWithCommit = (): typeof PinState.Type => ({
  _tag: 'Success',
  member: 'effect',
  action: 'pin',
  commit: 'abc1234def5678',
})

const createUnpinSuccess = (): typeof PinState.Type => ({
  _tag: 'Success',
  member: 'effect',
  action: 'unpin',
})

const createAlreadyPinned = (): typeof PinState.Type => ({
  _tag: 'Already',
  member: 'effect',
  action: 'pin',
  commit: 'abc1234def5678',
})

const createAlreadyUnpinned = (): typeof PinState.Type => ({
  _tag: 'Already',
  member: 'effect',
  action: 'unpin',
})

const createDryRunFull = (): typeof PinState.Type => ({
  _tag: 'DryRun',
  member: 'effect',
  action: 'pin',
  ref: 'v3.0.0',
  currentSource: 'effect-ts/effect',
  newSource: 'effect-ts/effect#v3.0.0',
  currentSymlink: '~/.megarepo/.../refs/heads/main',
  newSymlink: '~/.megarepo/.../refs/tags/v3.0.0',
  lockChanges: ['ref: main → v3.0.0', 'pinned: true'],
  wouldCreateWorktree: true,
})

const createDryRunSimple = (): typeof PinState.Type => ({
  _tag: 'DryRun',
  member: 'effect',
  action: 'pin',
  commit: 'abc1234def5678',
  lockChanges: ['pinned: false → true'],
})

const createErrorNotInMegarepo = (): typeof PinState.Type => ({
  _tag: 'Error',
  error: 'not_in_megarepo',
  message: 'Not in a megarepo',
})

const createErrorMemberNotFound = (): typeof PinState.Type => ({
  _tag: 'Error',
  error: 'member_not_found',
  message: "Member 'unknown-repo' not found",
})

const createErrorNotSynced = (): typeof PinState.Type => ({
  _tag: 'Error',
  error: 'not_synced',
  message: "Member 'effect' not synced yet",
})

const createErrorLocalPath = (): typeof PinState.Type => ({
  _tag: 'Error',
  error: 'local_path',
  message: 'Cannot pin local path members',
})

const createErrorNotInLock = (): typeof PinState.Type => ({
  _tag: 'Error',
  error: 'not_in_lock',
  message: "Member 'effect' not in lock file",
})

const createWarningWorktreeNotAvailable = (): typeof PinState.Type => ({
  _tag: 'Warning',
  warning: 'worktree_not_available',
})

const createWarningMemberRemovedFromConfig = (): typeof PinState.Type => ({
  _tag: 'Warning',
  warning: 'member_removed_from_config',
  member: 'old-member',
})

// =============================================================================
// Meta
// =============================================================================

export default {
  title: 'CLI/Pin Output',
  component: PinView,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component: 'Output for the `mr pin` and `mr unpin` commands.',
      },
    },
  },
} satisfies Meta<typeof PinView>

type Story = StoryObj<typeof PinView>

// =============================================================================
// Pin Output Stories
// =============================================================================

export const PinWithRef: Story = {
  render: () => (
    <TuiStoryPreview
      View={PinView}
      app={PinApp}
      initialState={createPinSuccessWithRef()}
    />
  ),
}

export const PinCurrentCommit: Story = {
  render: () => (
    <TuiStoryPreview
      View={PinView}
      app={PinApp}
      initialState={createPinSuccessWithCommit()}
    />
  ),
}

export const Unpin: Story = {
  render: () => (
    <TuiStoryPreview
      View={PinView}
      app={PinApp}
      initialState={createUnpinSuccess()}
    />
  ),
}

export const AlreadyPinned: Story = {
  render: () => (
    <TuiStoryPreview
      View={PinView}
      app={PinApp}
      initialState={createAlreadyPinned()}
    />
  ),
}

export const AlreadyUnpinned: Story = {
  render: () => (
    <TuiStoryPreview
      View={PinView}
      app={PinApp}
      initialState={createAlreadyUnpinned()}
    />
  ),
}

export const DryRunFull: Story = {
  render: () => (
    <TuiStoryPreview
      View={PinView}
      app={PinApp}
      initialState={createDryRunFull()}
    />
  ),
}

export const DryRunSimple: Story = {
  render: () => (
    <TuiStoryPreview
      View={PinView}
      app={PinApp}
      initialState={createDryRunSimple()}
    />
  ),
}

// =============================================================================
// Pin Error Stories
// =============================================================================

export const ErrorNotInMegarepo: Story = {
  render: () => (
    <TuiStoryPreview
      View={PinView}
      app={PinApp}
      initialState={createErrorNotInMegarepo()}
    />
  ),
}

export const ErrorMemberNotFound: Story = {
  render: () => (
    <TuiStoryPreview
      View={PinView}
      app={PinApp}
      initialState={createErrorMemberNotFound()}
    />
  ),
}

export const ErrorNotSynced: Story = {
  render: () => (
    <TuiStoryPreview
      View={PinView}
      app={PinApp}
      initialState={createErrorNotSynced()}
    />
  ),
}

export const ErrorLocalPath: Story = {
  render: () => (
    <TuiStoryPreview
      View={PinView}
      app={PinApp}
      initialState={createErrorLocalPath()}
    />
  ),
}

export const ErrorNotInLock: Story = {
  render: () => (
    <TuiStoryPreview
      View={PinView}
      app={PinApp}
      initialState={createErrorNotInLock()}
    />
  ),
}

// =============================================================================
// Pin Warning Stories
// =============================================================================

export const WarningWorktreeNotAvailable: Story = {
  render: () => (
    <TuiStoryPreview
      View={PinView}
      app={PinApp}
      initialState={createWarningWorktreeNotAvailable()}
    />
  ),
}

export const WarningMemberRemovedFromConfig: Story = {
  render: () => (
    <TuiStoryPreview
      View={PinView}
      app={PinApp}
      initialState={createWarningMemberRemovedFromConfig()}
    />
  ),
}
