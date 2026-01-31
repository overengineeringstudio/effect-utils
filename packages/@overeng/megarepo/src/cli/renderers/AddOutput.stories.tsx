/**
 * Storybook stories for AddOutput component.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TerminalPreview } from '@overeng/tui-react/storybook'

import {
  AddOutput,
  AddErrorOutput,
  type AddOutputProps,
} from './AddOutput.tsx'

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

const meta: Meta<AddOutputProps> = {
  title: 'CLI/Add Output',
  component: AddOutput,
  args: {
    member: 'effect',
    source: 'effect-ts/effect',
  },
  argTypes: {
    syncStatus: {
      control: { type: 'select' },
      options: ['cloned', 'synced', 'error'],
    },
  },
  decorators: [
    (Story) => (
      <TerminalPreview height={200}>
        <Story />
      </TerminalPreview>
    ),
  ],
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component: 'Output for the `mr add` command.',
      },
    },
  },
}

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

export const ErrorNotInMegarepo: Story = {
  render: () => (
    <TerminalPreview height={150}>
      <AddErrorOutput error="not_in_megarepo" />
    </TerminalPreview>
  ),
}

export const ErrorInvalidRepo: Story = {
  render: () => (
    <TerminalPreview height={150}>
      <AddErrorOutput error="invalid_repo" repo="not-a-valid-repo" />
    </TerminalPreview>
  ),
}

export const ErrorAlreadyExists: Story = {
  render: () => (
    <TerminalPreview height={150}>
      <AddErrorOutput error="already_exists" member="effect" />
    </TerminalPreview>
  ),
}
