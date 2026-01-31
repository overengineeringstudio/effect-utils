/**
 * Storybook stories for AddOutput component.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { AddOutput, AddErrorOutput, type AddOutputProps } from './AddOutput.tsx'

// =============================================================================
// Meta
// =============================================================================

const meta: Meta<AddOutputProps> = {
  title: 'CLI/Add Output',
  component: AddOutput,
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

// =============================================================================
// Add Output Stories
// =============================================================================

export const AddSimple: Story = {
  render: () => (
    <TuiStoryPreview>
      <AddOutput member="effect" source="effect-ts/effect" />
    </TuiStoryPreview>
  ),
}

export const AddWithSync: Story = {
  render: () => (
    <TuiStoryPreview>
      <AddOutput member="effect" source="effect-ts/effect" synced syncStatus="cloned" />
    </TuiStoryPreview>
  ),
}

export const AddWithSyncExisting: Story = {
  render: () => (
    <TuiStoryPreview>
      <AddOutput member="effect" source="effect-ts/effect" synced syncStatus="synced" />
    </TuiStoryPreview>
  ),
}

export const AddWithSyncError: Story = {
  render: () => (
    <TuiStoryPreview>
      <AddOutput
        member="private-repo"
        source="org/private-repo"
        synced
        syncStatus="error"
        syncMessage="authentication required"
      />
    </TuiStoryPreview>
  ),
}

// =============================================================================
// Add Error Stories
// =============================================================================

export const ErrorNotInMegarepo: Story = {
  render: () => (
    <TuiStoryPreview>
      <AddErrorOutput error="not_in_megarepo" />
    </TuiStoryPreview>
  ),
}

export const ErrorInvalidRepo: Story = {
  render: () => (
    <TuiStoryPreview>
      <AddErrorOutput error="invalid_repo" repo="not-a-valid-repo" />
    </TuiStoryPreview>
  ),
}

export const ErrorAlreadyExists: Story = {
  render: () => (
    <TuiStoryPreview>
      <AddErrorOutput error="already_exists" member="effect" />
    </TuiStoryPreview>
  ),
}
