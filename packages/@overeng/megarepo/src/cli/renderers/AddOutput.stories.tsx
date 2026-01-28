/**
 * Storybook stories for AddOutput component.
 */

import type { StoryObj } from '@storybook/react'
import { createCliMeta } from '@overeng/tui-react/storybook'
import { forceColorLevel } from '@overeng/cli-ui'
import { AddOutput, AddErrorOutput, type AddOutputProps, type AddErrorOutputProps } from './AddOutput.tsx'

forceColorLevel('truecolor')

// =============================================================================
// Example Data
// =============================================================================

const exampleAddSuccess: AddOutputProps = {
  member: 'effect',
  source: 'effect-ts/effect',
}

const exampleAddWithSync: AddOutputProps = {
  member: 'effect',
  source: 'effect-ts/effect',
  synced: true,
  syncStatus: 'cloned',
}

const exampleAddSyncError: AddOutputProps = {
  member: 'private-repo',
  source: 'org/private-repo',
  synced: true,
  syncStatus: 'error',
  syncMessage: 'authentication required',
}

// =============================================================================
// Add Output Stories
// =============================================================================

const meta = createCliMeta<AddOutputProps>(AddOutput, {
  title: 'CLI/Add Output',
  description: 'Output for the `mr add` command.',
  defaultArgs: {
    member: 'effect',
    source: 'effect-ts/effect',
  },
  argTypes: {
    syncStatus: {
      control: { type: 'select' },
      options: ['cloned', 'synced', 'error'],
    },
  },
  terminalHeight: 200,
})

export default meta

type Story = StoryObj<typeof meta>

export const AddSimple: Story = {
  args: exampleAddSuccess,
}

export const AddWithSync: Story = {
  args: exampleAddWithSync,
}

export const AddWithSyncExisting: Story = {
  args: {
    member: 'effect',
    source: 'effect-ts/effect',
    synced: true,
    syncStatus: 'synced',
  },
}

export const AddWithSyncError: Story = {
  args: exampleAddSyncError,
}

// =============================================================================
// Add Error Stories
// =============================================================================

export const errorMeta = createCliMeta<AddErrorOutputProps>(AddErrorOutput, {
  title: 'CLI/Add Error',
  description: 'Error outputs for the `mr add` command.',
  defaultArgs: {
    error: 'not_in_megarepo',
  },
  argTypes: {
    error: {
      control: { type: 'select' },
      options: ['not_in_megarepo', 'invalid_repo', 'already_exists'],
    },
  },
  terminalHeight: 150,
})

type ErrorStory = StoryObj<typeof errorMeta>

export const ErrorNotInMegarepo: ErrorStory = {
  args: { error: 'not_in_megarepo' },
}

export const ErrorInvalidRepo: ErrorStory = {
  args: { error: 'invalid_repo', repo: 'not-a-valid-repo' },
}

export const ErrorAlreadyExists: ErrorStory = {
  args: { error: 'already_exists', member: 'effect' },
}
