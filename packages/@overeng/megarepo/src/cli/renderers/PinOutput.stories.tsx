/**
 * Storybook stories for PinOutput component.
 */

import type { StoryObj } from '@storybook/react'

import { forceColorLevel } from '@overeng/cli-ui'
import { createCliMeta } from '@overeng/tui-react/storybook'

import {
  PinOutput,
  PinErrorOutput,
  type PinOutputProps,
  type PinErrorOutputProps,
} from './PinOutput.tsx'

forceColorLevel('truecolor')

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

const meta = createCliMeta<PinOutputProps>(PinOutput, {
  title: 'CLI/Pin Output',
  description: 'Output for the `mr pin` and `mr unpin` commands.',
  defaultArgs: {
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
  terminalHeight: 200,
})

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

export const errorMeta = createCliMeta<PinErrorOutputProps>(PinErrorOutput, {
  title: 'CLI/Pin Error',
  description: 'Error outputs for the `mr pin` and `mr unpin` commands.',
  defaultArgs: {
    error: 'not_in_megarepo',
  },
  argTypes: {
    error: {
      control: { type: 'select' },
      options: ['not_in_megarepo', 'member_not_found', 'not_synced', 'local_path'],
    },
  },
  terminalHeight: 150,
})

type ErrorStory = StoryObj<typeof errorMeta>

export const ErrorNotInMegarepo: ErrorStory = {
  args: { error: 'not_in_megarepo' },
}

export const ErrorMemberNotFound: ErrorStory = {
  args: { error: 'member_not_found', member: 'unknown-repo' },
}

export const ErrorNotSynced: ErrorStory = {
  args: { error: 'not_synced', member: 'effect' },
}

export const ErrorLocalPath: ErrorStory = {
  args: { error: 'local_path' },
}
