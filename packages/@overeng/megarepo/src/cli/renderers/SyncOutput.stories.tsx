/**
 * Storybook stories for SyncOutput component.
 */

import type { StoryObj } from '@storybook/react'
import React from 'react'
import { createCliMeta, TerminalPreview, StringTerminalPreview } from '@overeng/tui-react/storybook'
import { forceColorLevel } from '@overeng/cli-ui'
import { SyncOutput, type SyncOutputProps, type MemberSyncResult } from './SyncOutput.tsx'

forceColorLevel('truecolor')

// =============================================================================
// Example Data
// =============================================================================

const exampleSyncResults: MemberSyncResult[] = [
  { name: 'effect', status: 'already_synced' },
  { name: 'effect-utils', status: 'synced', ref: 'main' },
  { name: 'livestore', status: 'cloned', ref: 'main' },
  { name: 'dotfiles', status: 'updated', commit: 'abc1234def', previousCommit: '9876543fed' },
  { name: 'private-repo', status: 'skipped', message: 'dirty worktree' },
]

const exampleSyncResultsWithErrors: MemberSyncResult[] = [
  { name: 'effect', status: 'synced', ref: 'main' },
  { name: 'broken-repo', status: 'error', message: 'network timeout' },
  { name: 'missing-repo', status: 'error', message: 'repository not found' },
  { name: 'effect-utils', status: 'already_synced' },
]

const exampleAllSynced: MemberSyncResult[] = [
  { name: 'effect', status: 'already_synced' },
  { name: 'effect-utils', status: 'already_synced' },
  { name: 'livestore', status: 'already_synced' },
  { name: 'dotfiles', status: 'already_synced' },
  { name: 'schickling.dev', status: 'already_synced' },
]

// =============================================================================
// Meta
// =============================================================================

const meta = createCliMeta<SyncOutputProps>(SyncOutput, {
  title: 'CLI/Sync Output',
  description: 'Sync command output. Shows results of syncing members in a megarepo.',
  defaultArgs: {
    name: 'my-workspace',
    root: '/Users/dev/workspace',
    results: [],
    dryRun: false,
    frozen: false,
    pull: false,
    deep: false,
  },
  argTypes: {
    dryRun: {
      description: 'Dry run mode - shows what would happen without making changes',
      control: { type: 'boolean' },
      table: { category: 'Sync Options' },
    },
    frozen: {
      description: 'Frozen mode (CI) - use exact commits from lock file',
      control: { type: 'boolean' },
      table: { category: 'Sync Options' },
    },
    pull: {
      description: 'Pull mode - fetch and update to latest remote commits',
      control: { type: 'boolean' },
      table: { category: 'Sync Options' },
    },
    deep: {
      description: 'Deep sync - recursively sync nested megarepos',
      control: { type: 'boolean' },
      table: { category: 'Sync Options' },
    },
  },
})

export default meta

type Story = StoryObj<typeof meta>

// =============================================================================
// Basic Stories
// =============================================================================

export const MixedResults: Story = {
  args: {
    results: exampleSyncResults,
    nestedMegarepos: ['effect-utils'],
    generatedFiles: ['flake.nix', '.envrc'],
  },
}

export const DryRun: Story = {
  args: {
    results: [
      { name: 'new-repo', status: 'cloned', ref: 'main' },
      { name: 'effect', status: 'synced', ref: 'main' },
      { name: 'effect-utils', status: 'already_synced' },
    ],
    dryRun: true,
    generatedFiles: ['flake.nix'],
  },
}

export const AllSynced: Story = {
  args: {
    name: 'mr-all-blue',
    root: '/Users/dev/mr-all-blue',
    results: exampleAllSynced,
    dryRun: true,
  },
}

export const WithErrors: Story = {
  args: {
    results: exampleSyncResultsWithErrors,
  },
}

export const FrozenMode: Story = {
  args: {
    name: 'ci-workspace',
    root: '/home/runner/workspace',
    results: [
      { name: 'effect', status: 'synced', ref: 'main', commit: 'abc1234' },
      { name: 'effect-utils', status: 'synced', ref: 'main', commit: 'def5678' },
      { name: 'livestore', status: 'cloned', ref: 'v1.0.0', commit: '9876543' },
    ],
    frozen: true,
  },
}

export const PullMode: Story = {
  args: {
    results: [
      { name: 'effect', status: 'updated', commit: 'abc1234def', previousCommit: '9876543fed' },
      { name: 'effect-utils', status: 'updated', commit: 'def5678abc', previousCommit: 'fedcba987' },
      { name: 'livestore', status: 'already_synced' },
    ],
    pull: true,
  },
}

export const LockUpdates: Story = {
  args: {
    results: [
      { name: 'effect', status: 'locked', commit: 'abc1234def', previousCommit: '9876543fed' },
      { name: 'effect-utils', status: 'locked', commit: 'def5678abc', previousCommit: 'fedcba987' },
      { name: 'livestore', status: 'already_synced' },
    ],
  },
}

export const RemovedMembers: Story = {
  args: {
    results: [
      { name: 'effect', status: 'synced', ref: 'main' },
      { name: 'old-repo', status: 'removed', message: '/store/old-repo-abc123' },
      { name: 'deprecated', status: 'removed', message: '/store/deprecated-def456' },
    ],
  },
}

export const SkippedMembers: Story = {
  args: {
    results: [
      { name: 'effect', status: 'synced', ref: 'main' },
      { name: 'dirty-repo', status: 'skipped', message: 'dirty worktree' },
      { name: 'pinned-repo', status: 'skipped', message: 'pinned' },
      { name: 'private-repo', status: 'skipped', message: 'authentication required' },
    ],
  },
}

export const NestedMegareposHint: Story = {
  args: {
    results: [
      { name: 'effect', status: 'synced', ref: 'main' },
      { name: 'effect-utils', status: 'synced', ref: 'main' },
      { name: 'livestore', status: 'synced', ref: 'main' },
    ],
    nestedMegarepos: ['effect-utils', 'livestore'],
    deep: false,
  },
}

export const DeepSyncMode: Story = {
  args: {
    results: [
      { name: 'effect', status: 'synced', ref: 'main' },
      { name: 'effect-utils', status: 'synced', ref: 'main' },
      { name: 'livestore', status: 'synced', ref: 'main' },
    ],
    nestedMegarepos: ['effect-utils', 'livestore'],
    deep: true,
  },
}

export const WithGenerators: Story = {
  args: {
    results: [
      { name: 'effect', status: 'synced', ref: 'main' },
      { name: 'effect-utils', status: 'synced', ref: 'main' },
      { name: 'livestore', status: 'cloned', ref: 'main' },
      { name: 'dotfiles', status: 'already_synced' },
    ],
    generatedFiles: ['flake.nix', 'flake.lock', '.envrc.generated.megarepo', '.vscode/megarepo.code-workspace'],
  },
}

export const ManyMembers: Story = {
  args: {
    name: 'large-workspace',
    root: '/Users/dev/large-workspace',
    results: Array.from({ length: 10 }, (_, i) => ({
      name: `repo-${String(i + 1).padStart(2, '0')}`,
      status: 'already_synced' as const,
    })),
  },
}

// =============================================================================
// Edge Cases
// =============================================================================

export const FirstSync: Story = {
  args: {
    name: 'new-workspace',
    root: '/Users/dev/new-workspace',
    results: [
      { name: 'effect', status: 'cloned', ref: 'main' },
      { name: 'effect-utils', status: 'cloned', ref: 'main' },
      { name: 'livestore', status: 'cloned', ref: 'dev' },
      { name: 'dotfiles', status: 'cloned', ref: 'main' },
    ],
    generatedFiles: ['flake.nix', '.envrc.generated.megarepo'],
  },
}

export const AllErrors: Story = {
  args: {
    results: [
      { name: 'effect', status: 'error', message: 'network timeout' },
      { name: 'effect-utils', status: 'error', message: 'authentication failed' },
      { name: 'livestore', status: 'error', message: 'repository not found' },
      { name: 'private-repo', status: 'error', message: 'permission denied' },
    ],
  },
}

export const MixedSkipped: Story = {
  args: {
    results: [
      { name: 'effect', status: 'already_synced' },
      { name: 'dirty-repo', status: 'skipped', message: '5 uncommitted changes' },
      { name: 'pinned-repo', status: 'skipped', message: 'pinned to v1.0.0' },
      { name: 'auth-repo', status: 'skipped', message: 'authentication required' },
      { name: 'missing-ref', status: 'skipped', message: 'ref feature/x not found' },
    ],
  },
}

export const DeepSyncHint: Story = {
  args: {
    name: 'mr-all-blue',
    root: '/Users/dev/mr-all-blue',
    results: [
      { name: 'effect', status: 'synced', ref: 'main' },
      { name: 'effect-utils', status: 'synced', ref: 'main' },
      { name: 'livestore', status: 'synced', ref: 'dev' },
      { name: 'dotfiles', status: 'already_synced' },
    ],
    nestedMegarepos: ['effect-utils', 'livestore', 'dotfiles'],
    deep: false,
  },
}

export const SingleMember: Story = {
  args: {
    results: [{ name: 'effect', status: 'synced', ref: 'main' }],
  },
}

export const RefChanges: Story = {
  args: {
    results: [
      { name: 'effect', status: 'synced', ref: 'v3.1.0' },
      { name: 'effect-utils', status: 'updated', commit: 'abc1234', previousCommit: 'def5678' },
      { name: 'livestore', status: 'updated', commit: '1234567', previousCommit: '9876543' },
    ],
    pull: true,
  },
}

export const LongNames: Story = {
  args: {
    name: 'organization-name/extremely-long-workspace-name-for-testing',
    root: '/Users/dev/extremely-long-path-to-workspace-directory-for-testing-purposes',
    results: [
      { name: '@organization/extremely-long-package-name-for-testing', status: 'synced', ref: 'main' },
      { name: '@another-org/another-very-long-package-name', status: 'already_synced' },
      { name: 'short', status: 'cloned', ref: 'feature/very-long-branch-name-for-testing' },
    ],
  },
}

// =============================================================================
// Interactive Story
// =============================================================================

interface InteractiveProps extends SyncOutputProps {
  renderMode: 'tty' | 'string'
  clonedCount: number
  syncedCount: number
  updatedCount: number
  alreadySyncedCount: number
  skippedCount: number
  errorCount: number
}

export const Interactive: StoryObj<InteractiveProps> = {
  args: {
    name: 'my-workspace',
    root: '/Users/dev/workspace',
    renderMode: 'tty',
    clonedCount: 1,
    syncedCount: 2,
    updatedCount: 1,
    alreadySyncedCount: 3,
    skippedCount: 1,
    errorCount: 0,
  },
  argTypes: {
    clonedCount: { control: { type: 'range', min: 0, max: 10 }, table: { category: 'Results' } },
    syncedCount: { control: { type: 'range', min: 0, max: 10 }, table: { category: 'Results' } },
    updatedCount: { control: { type: 'range', min: 0, max: 10 }, table: { category: 'Results' } },
    alreadySyncedCount: { control: { type: 'range', min: 0, max: 10 }, table: { category: 'Results' } },
    skippedCount: { control: { type: 'range', min: 0, max: 10 }, table: { category: 'Results' } },
    errorCount: { control: { type: 'range', min: 0, max: 10 }, table: { category: 'Results' } },
  },
  render: ({ renderMode, clonedCount, syncedCount, updatedCount, alreadySyncedCount, skippedCount, errorCount, ...args }) => {
    const results: MemberSyncResult[] = []
    let idx = 0

    for (let i = 0; i < clonedCount; i++) results.push({ name: `cloned-repo-${++idx}`, status: 'cloned', ref: 'main' })
    for (let i = 0; i < syncedCount; i++) results.push({ name: `synced-repo-${++idx}`, status: 'synced', ref: 'main' })
    for (let i = 0; i < updatedCount; i++) results.push({ name: `updated-repo-${++idx}`, status: 'updated', commit: 'abc1234', previousCommit: 'def5678' })
    for (let i = 0; i < alreadySyncedCount; i++) results.push({ name: `already-synced-${++idx}`, status: 'already_synced' })
    for (let i = 0; i < skippedCount; i++) results.push({ name: `skipped-repo-${++idx}`, status: 'skipped', message: 'dirty worktree' })
    for (let i = 0; i < errorCount; i++) results.push({ name: `error-repo-${++idx}`, status: 'error', message: 'network error' })

    const props = { ...args, results }

    if (renderMode === 'string') {
      return <StringTerminalPreview component={SyncOutput} props={props} />
    }
    return <TerminalPreview><SyncOutput {...props} /></TerminalPreview>
  },
}
