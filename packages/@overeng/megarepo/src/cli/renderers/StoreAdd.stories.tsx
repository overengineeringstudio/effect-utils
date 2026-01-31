/**
 * Storybook stories for StoreAdd components.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TerminalPreview } from '@overeng/tui-react/storybook'

import {
  StoreAddError,
  StoreAddProgress,
  StoreAddSuccess,
  type StoreAddErrorProps,
  type StoreAddSuccessProps,
} from './StoreOutput.tsx'

// =============================================================================
// Example Data
// =============================================================================

const exampleAddSuccess: StoreAddSuccessProps = {
  source: 'effect-ts/effect',
  ref: 'main',
  commit: 'abc1234567890',
  path: '/Users/me/.megarepo/store/github.com/effect-ts/effect/refs/main',
  alreadyExists: false,
}

const exampleAddSuccessExisting: StoreAddSuccessProps = {
  source: 'effect-ts/effect',
  ref: 'main',
  commit: 'abc1234567890',
  path: '/Users/me/.megarepo/store/github.com/effect-ts/effect/refs/main',
  alreadyExists: true,
}

// =============================================================================
// Meta
// =============================================================================

const meta: Meta<StoreAddErrorProps> = {
  title: 'CLI/Store/Add',
  component: StoreAddError,
  args: {
    type: 'invalid_source',
  },
  argTypes: {
    type: {
      description: 'Error type',
      control: { type: 'select' },
      options: ['invalid_source', 'local_path', 'no_url'],
      table: { category: 'Error' },
    },
    source: {
      description: 'Source string that caused the error (for invalid_source)',
      control: { type: 'text' },
      table: { category: 'Error' },
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
        component: 'Error output for the `mr store add` command when inputs are invalid.',
      },
    },
  },
}

export default meta

type Story = StoryObj<typeof meta>

// =============================================================================
// Error Stories
// =============================================================================

export const InvalidSource: Story = {
  args: {
    type: 'invalid_source',
    source: 'not-a-valid-source',
  },
}

export const LocalPath: Story = {
  args: {
    type: 'local_path',
  },
}

export const NoUrl: Story = {
  args: {
    type: 'no_url',
  },
}

// =============================================================================
// Progress Stories
// =============================================================================

export const Cloning: Story = {
  render: () => (
    <TerminalPreview height={200}>
      <StoreAddProgress type="cloning" source="effect-ts/effect" />
    </TerminalPreview>
  ),
}

export const CreatingWorktree: Story = {
  render: () => (
    <TerminalPreview height={200}>
      <StoreAddProgress type="creating_worktree" ref="main" />
    </TerminalPreview>
  ),
}

// =============================================================================
// Success Stories
// =============================================================================

export const SuccessNew: Story = {
  render: () => (
    <TerminalPreview height={200}>
      <StoreAddSuccess {...exampleAddSuccess} />
    </TerminalPreview>
  ),
}

export const SuccessExisting: Story = {
  render: () => (
    <TerminalPreview height={200}>
      <StoreAddSuccess {...exampleAddSuccessExisting} />
    </TerminalPreview>
  ),
}

export const SuccessWithRef: Story = {
  render: () => (
    <TerminalPreview height={200}>
      <StoreAddSuccess
        source="effect-ts/effect#feat/new-feature"
        ref="feat/new-feature"
        commit="def456789012"
        path="/Users/me/.megarepo/store/github.com/effect-ts/effect/refs/feat/new-feature"
        alreadyExists={false}
      />
    </TerminalPreview>
  ),
}

export const SuccessNoCommit: Story = {
  render: () => (
    <TerminalPreview height={200}>
      <StoreAddSuccess
        source="effect-ts/effect"
        ref="v3.0.0"
        commit={undefined}
        path="/Users/me/.megarepo/store/github.com/effect-ts/effect/refs/v3.0.0"
        alreadyExists={false}
      />
    </TerminalPreview>
  ),
}
