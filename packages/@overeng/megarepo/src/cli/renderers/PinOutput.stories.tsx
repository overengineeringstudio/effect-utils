/**
 * Storybook stories for PinOutput component.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TerminalPreview } from '@overeng/tui-react/storybook'

import {
  PinOutput,
  PinErrorOutput,
  type PinOutputProps,
} from './PinOutput.tsx'

// =============================================================================
// Example Data
// =============================================================================

const examplePinSuccess: PinOutputProps = {
  action: 'pin',
  member: 'effect',
  status: 'success',
  ref: 'v3.0.0',
  commit: 'abc1234def5678',
}

const examplePinDryRun: PinOutputProps = {
  action: 'pin',
  member: 'effect',
  status: 'dry_run',
  ref: 'v3.0.0',
  dryRun: {
    currentSource: 'effect-ts/effect',
    newSource: 'effect-ts/effect#v3.0.0',
    currentSymlink: '~/.megarepo/.../refs/heads/main',
    newSymlink: '~/.megarepo/.../refs/tags/v3.0.0',
    lockChanges: ['ref: main → v3.0.0', 'pinned: true'],
    wouldCreateWorktree: true,
  },
}

const exampleUnpinSuccess: PinOutputProps = {
  action: 'unpin',
  member: 'effect',
  status: 'success',
}

// =============================================================================
// Pin Output Stories
// =============================================================================

const meta: Meta<PinOutputProps> = {
  title: 'CLI/Pin Output',
  component: PinOutput,
  args: {
    action: 'pin',
    member: 'effect',
    status: 'success',
  },
  argTypes: {
    action: {
      control: { type: 'radio' },
      options: ['pin', 'unpin'],
    },
    status: {
      control: { type: 'select' },
      options: ['success', 'already_pinned', 'already_unpinned', 'dry_run'],
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
        component: 'Output for the `mr pin` and `mr unpin` commands.',
      },
    },
  },
}

export default meta

type Story = StoryObj<typeof meta>

export const PinWithRef: Story = {
  args: examplePinSuccess,
}

export const PinCurrentCommit: Story = {
  args: {
    action: 'pin',
    member: 'effect',
    status: 'success',
    commit: 'abc1234def5678',
  },
}

export const Unpin: Story = {
  args: exampleUnpinSuccess,
}

export const AlreadyPinned: Story = {
  args: {
    action: 'pin',
    member: 'effect',
    status: 'already_pinned',
    commit: 'abc1234def5678',
  },
}

export const AlreadyUnpinned: Story = {
  args: {
    action: 'unpin',
    member: 'effect',
    status: 'already_unpinned',
  },
}

export const DryRunFull: Story = {
  args: examplePinDryRun,
}

export const DryRunSimple: Story = {
  args: {
    action: 'pin',
    member: 'effect',
    status: 'dry_run',
    commit: 'abc1234def5678',
    dryRun: {
      lockChanges: ['pinned: false → true'],
    },
  },
}

// =============================================================================
// Pin Error Stories
// =============================================================================

export const ErrorNotInMegarepo: Story = {
  render: () => (
    <TerminalPreview height={150}>
      <PinErrorOutput error="not_in_megarepo" />
    </TerminalPreview>
  ),
}

export const ErrorMemberNotFound: Story = {
  render: () => (
    <TerminalPreview height={150}>
      <PinErrorOutput error="member_not_found" member="unknown-repo" />
    </TerminalPreview>
  ),
}

export const ErrorNotSynced: Story = {
  render: () => (
    <TerminalPreview height={150}>
      <PinErrorOutput error="not_synced" member="effect" />
    </TerminalPreview>
  ),
}

export const ErrorLocalPath: Story = {
  render: () => (
    <TerminalPreview height={150}>
      <PinErrorOutput error="local_path" />
    </TerminalPreview>
  ),
}
