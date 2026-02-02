/**
 * Storybook stories for AddOutput component.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import type { AddState } from './AddOutput/mod.ts'
import { AddApp } from './AddOutput/mod.ts'
import { AddView } from './AddOutput/view.tsx'

// =============================================================================
// State Factories
// =============================================================================


const createSuccessState = (): typeof AddState.Type => ({
  _tag: 'Success',
  member: 'effect',
  source: 'effect-ts/effect',
  synced: false,
})

const createSuccessSyncedState = (): typeof AddState.Type => ({
  _tag: 'Success',
  member: 'effect',
  source: 'effect-ts/effect',
  synced: true,
  syncStatus: 'cloned',
})

const createSuccessSyncedExistingState = (): typeof AddState.Type => ({
  _tag: 'Success',
  member: 'effect',
  source: 'effect-ts/effect',
  synced: true,
  syncStatus: 'synced',
})

const createSuccessSyncErrorState = (): typeof AddState.Type => ({
  _tag: 'Success',
  member: 'private-repo',
  source: 'org/private-repo',
  synced: true,
  syncStatus: 'error',
})

const createErrorNotInMegarepoState = (): typeof AddState.Type => ({
  _tag: 'Error',
  error: 'not_in_megarepo',
  message: 'No megarepo.json found',
})

const createErrorInvalidRepoState = (): typeof AddState.Type => ({
  _tag: 'Error',
  error: 'invalid_repo',
  message: 'Invalid repo reference: not-a-valid-repo',
})

const createErrorAlreadyExistsState = (): typeof AddState.Type => ({
  _tag: 'Error',
  error: 'already_exists',
  message: "Member 'effect' already exists",
})

// =============================================================================
// Meta
// =============================================================================

export default {
  title: 'CLI/Add Output',
  component: AddView,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component: 'Output for the `mr add` command.',
      },
    },
  },
} satisfies Meta<typeof AddView>

type Story = StoryObj<typeof AddView>

// =============================================================================
// Add Output Stories
// =============================================================================

export const AddSimple: Story = {
  render: () => <TuiStoryPreview View={AddView} app={AddApp} initialState={createSuccessState()} />,
}

export const AddWithSync: Story = {
  render: () => (
    <TuiStoryPreview View={AddView} app={AddApp} initialState={createSuccessSyncedState()} />
  ),
}

export const AddWithSyncExisting: Story = {
  render: () => (
    <TuiStoryPreview
      View={AddView}
      app={AddApp}
      initialState={createSuccessSyncedExistingState()}
    />
  ),
}

export const AddWithSyncError: Story = {
  render: () => (
    <TuiStoryPreview View={AddView} app={AddApp} initialState={createSuccessSyncErrorState()} />
  ),
}

// =============================================================================
// Add Error Stories
// =============================================================================

export const ErrorNotInMegarepo: Story = {
  render: () => (
    <TuiStoryPreview View={AddView} app={AddApp} initialState={createErrorNotInMegarepoState()} />
  ),
}

export const ErrorInvalidRepo: Story = {
  render: () => (
    <TuiStoryPreview View={AddView} app={AddApp} initialState={createErrorInvalidRepoState()} />
  ),
}

export const ErrorAlreadyExists: Story = {
  render: () => (
    <TuiStoryPreview View={AddView} app={AddApp} initialState={createErrorAlreadyExistsState()} />
  ),
}
