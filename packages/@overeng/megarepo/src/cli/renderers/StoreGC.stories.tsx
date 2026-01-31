/**
 * Storybook stories for StoreGcOutput component.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TerminalPreview } from '@overeng/tui-react/storybook'

import { StoreGcOutput, type StoreGcOutputProps, type StoreGcResult } from './StoreOutput.tsx'

// =============================================================================
// Example Data
// =============================================================================

const exampleGcResults: StoreGcResult[] = [
  {
    repo: 'github.com/effect-ts/effect',
    ref: 'feat/old-branch',
    path: '/store/...',
    status: 'removed',
  },
  {
    repo: 'github.com/effect-ts/effect',
    ref: 'main',
    path: '/store/...',
    status: 'skipped_in_use',
  },
  {
    repo: 'github.com/overengineeringstudio/effect-utils',
    ref: 'dev',
    path: '/store/...',
    status: 'skipped_dirty',
  },
]

// =============================================================================
// Meta
// =============================================================================

const meta: Meta<StoreGcOutputProps> = {
  title: 'CLI/Store/GC',
  component: StoreGcOutput,
  args: {
    basePath: '/Users/dev/.megarepo',
    results: [],
    dryRun: false,
    showForceHint: true,
    maxInUseToShow: 5,
  },
  argTypes: {
    dryRun: {
      description: 'Dry run mode - shows what would be removed without removing',
      control: { type: 'boolean' },
      table: { category: 'Options' },
    },
    showForceHint: {
      description: 'Show hint to use --force for dirty worktrees',
      control: { type: 'boolean' },
      table: { category: 'Options' },
    },
    maxInUseToShow: {
      description: 'Max number of in-use worktrees to show individually',
      control: { type: 'number' },
      table: { category: 'Options' },
    },
  },
  decorators: [
    (Story) => (
      <TerminalPreview height={400}>
        <Story />
      </TerminalPreview>
    ),
  ],
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Output for the `mr store gc` command. Shows garbage collection results for worktrees.',
      },
    },
  },
}

export default meta

type Story = StoryObj<typeof meta>

// =============================================================================
// Stories
// =============================================================================

export const Mixed: Story = {
  args: {
    results: exampleGcResults,
  },
}

export const DryRun: Story = {
  args: {
    results: [
      {
        repo: 'github.com/effect-ts/effect',
        ref: 'feat/old-branch',
        path: '/store/...',
        status: 'removed',
      },
      {
        repo: 'github.com/effect-ts/effect',
        ref: 'fix/deprecated',
        path: '/store/...',
        status: 'removed',
      },
    ],
    dryRun: true,
  },
}

export const OnlyCurrentMegarepo: Story = {
  args: {
    results: exampleGcResults,
    warning: { type: 'only_current_megarepo' },
  },
}

export const NotInMegarepo: Story = {
  args: {
    results: [
      { repo: 'github.com/effect-ts/effect', ref: 'main', path: '/store/...', status: 'removed' },
      {
        repo: 'github.com/effect-ts/effect',
        ref: 'feat/old',
        path: '/store/...',
        status: 'removed',
      },
    ],
    warning: { type: 'not_in_megarepo' },
    dryRun: true,
  },
}

export const CustomWarning: Story = {
  args: {
    results: exampleGcResults,
    warning: { type: 'custom', message: 'Custom warning message for edge case' },
  },
}

export const Empty: Story = {
  args: {
    results: [],
  },
}

export const AllSkipped: Story = {
  args: {
    results: [
      {
        repo: 'github.com/effect-ts/effect',
        ref: 'main',
        path: '/store/...',
        status: 'skipped_in_use',
      },
      {
        repo: 'github.com/effect-ts/effect',
        ref: 'dev',
        path: '/store/...',
        status: 'skipped_dirty',
      },
      {
        repo: 'github.com/overengineeringstudio/effect-utils',
        ref: 'main',
        path: '/store/...',
        status: 'skipped_in_use',
      },
    ],
  },
}

export const AllRemoved: Story = {
  args: {
    results: [
      {
        repo: 'github.com/effect-ts/effect',
        ref: 'feat/old-1',
        path: '/store/...',
        status: 'removed',
      },
      {
        repo: 'github.com/effect-ts/effect',
        ref: 'feat/old-2',
        path: '/store/...',
        status: 'removed',
      },
      {
        repo: 'github.com/effect-ts/effect',
        ref: 'feat/old-3',
        path: '/store/...',
        status: 'removed',
      },
      {
        repo: 'github.com/overengineeringstudio/effect-utils',
        ref: 'experiment',
        path: '/store/...',
        status: 'removed',
      },
    ],
  },
}

export const AllErrors: Story = {
  args: {
    results: [
      {
        repo: 'github.com/effect-ts/effect',
        ref: 'main',
        path: '/store/...',
        status: 'error',
        message: 'Permission denied',
      },
      {
        repo: 'github.com/effect-ts/effect',
        ref: 'dev',
        path: '/store/...',
        status: 'error',
        message: 'Directory not found',
      },
      {
        repo: 'github.com/overengineeringstudio/effect-utils',
        ref: 'main',
        path: '/store/...',
        status: 'error',
        message: 'Lock file in use',
      },
    ],
  },
}

export const ManyInUse: Story = {
  args: {
    results: [
      {
        repo: 'github.com/effect-ts/effect',
        ref: 'main',
        path: '/store/...',
        status: 'skipped_in_use',
      },
      {
        repo: 'github.com/effect-ts/effect',
        ref: 'dev',
        path: '/store/...',
        status: 'skipped_in_use',
      },
      {
        repo: 'github.com/effect-ts/effect',
        ref: 'feat/a',
        path: '/store/...',
        status: 'skipped_in_use',
      },
      {
        repo: 'github.com/effect-ts/effect',
        ref: 'feat/b',
        path: '/store/...',
        status: 'skipped_in_use',
      },
      {
        repo: 'github.com/effect-ts/effect',
        ref: 'feat/c',
        path: '/store/...',
        status: 'skipped_in_use',
      },
      {
        repo: 'github.com/effect-ts/effect',
        ref: 'feat/d',
        path: '/store/...',
        status: 'skipped_in_use',
      },
      {
        repo: 'github.com/overengineeringstudio/effect-utils',
        ref: 'main',
        path: '/store/...',
        status: 'skipped_in_use',
      },
      {
        repo: 'github.com/overengineeringstudio/effect-utils',
        ref: 'dev',
        path: '/store/...',
        status: 'skipped_in_use',
      },
    ],
    maxInUseToShow: 3,
  },
}

export const DirtyWithDetails: Story = {
  args: {
    results: [
      {
        repo: 'github.com/effect-ts/effect',
        ref: 'feature-branch',
        path: '/store/...',
        status: 'skipped_dirty',
        message: '5 uncommitted change(s)',
      },
      {
        repo: 'github.com/effect-ts/effect',
        ref: 'wip-branch',
        path: '/store/...',
        status: 'skipped_dirty',
        message: 'has unpushed commits',
      },
      {
        repo: 'github.com/overengineeringstudio/effect-utils',
        ref: 'experimental',
        path: '/store/...',
        status: 'skipped_dirty',
        message: '12 uncommitted change(s)',
      },
    ],
    showForceHint: true,
  },
}

export const DryRunForceMode: Story = {
  args: {
    results: [
      {
        repo: 'github.com/effect-ts/effect',
        ref: 'dirty-branch',
        path: '/store/...',
        status: 'removed',
      },
      {
        repo: 'github.com/effect-ts/effect',
        ref: 'clean-branch',
        path: '/store/...',
        status: 'removed',
      },
    ],
    dryRun: true,
    showForceHint: false,
  },
}

export const LargeCleanup: Story = {
  args: {
    results: [
      {
        repo: 'github.com/effect-ts/effect',
        ref: 'feat/old-1',
        path: '/store/...',
        status: 'removed',
      },
      {
        repo: 'github.com/effect-ts/effect',
        ref: 'feat/old-2',
        path: '/store/...',
        status: 'removed',
      },
      {
        repo: 'github.com/effect-ts/effect',
        ref: 'feat/old-3',
        path: '/store/...',
        status: 'removed',
      },
      {
        repo: 'github.com/overengineeringstudio/effect-utils',
        ref: 'wip',
        path: '/store/...',
        status: 'skipped_dirty',
        message: '3 uncommitted change(s)',
      },
      {
        repo: 'github.com/livestorejs/livestore',
        ref: 'main',
        path: '/store/...',
        status: 'skipped_in_use',
      },
      {
        repo: 'github.com/livestorejs/livestore',
        ref: 'dev',
        path: '/store/...',
        status: 'skipped_in_use',
      },
      {
        repo: 'github.com/private/repo',
        ref: 'main',
        path: '/store/...',
        status: 'error',
        message: 'Permission denied',
      },
    ],
    warning: { type: 'only_current_megarepo' },
  },
}
