/**
 * Storybook stories for SyncOutput component.
 *
 * Uses the TuiStoryPreview with atom-based view pattern.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview, type OutputTab } from '@overeng/tui-react/storybook'

import type { MemberSyncResult } from '../../lib/sync/schema.ts'
import { SyncState, SyncAction, syncReducer, type SyncState as SyncStateType } from './SyncOutput/schema.ts'
import { SyncView } from './SyncOutput/view.tsx'

// =============================================================================
// Output Tabs
// =============================================================================

const ALL_TABS: OutputTab[] = [
  'tty',
  'alt-screen',
  'ci',
  'ci-plain',
  'pipe',
  'log',
  'json',
  'ndjson',
]

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
// State Factories
// =============================================================================

const createBaseState = (overrides?: Partial<SyncStateType>): SyncStateType => ({
  workspace: { name: 'my-workspace', root: '/Users/dev/workspace' },
  options: { dryRun: false, frozen: false, pull: false, deep: false },
  phase: 'complete',
  members: [],
  results: [],
  logs: [],
  nestedMegarepos: [],
  generatedFiles: [],
  ...overrides,
})

// =============================================================================
// Meta
// =============================================================================

const meta = {
  title: 'CLI/Sync Output',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: `
Sync command output. Shows results of syncing members in a megarepo.

**Demonstrates:**
- Member sync status display (cloned, synced, updated, etc.)
- Progress tracking during sync
- Summary counts and generated files
- All output modes: TTY, CI, JSON, NDJSON
- **Atom-based view pattern** - view receives stateAtom and subscribes internally

**View Pattern:**
\`\`\`typescript
// CLI
<SyncView stateAtom={SyncApp.stateAtom} />

// Storybook - TuiStoryPreview creates atom internally
<TuiStoryPreview View={SyncView} ... />
\`\`\`
        `,
      },
    },
  },
} satisfies Meta

export default meta

type Story = StoryObj<{ height: number }>

// =============================================================================
// Basic Stories
// =============================================================================

export const MixedResults: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={SyncView}
      stateSchema={SyncState}
      actionSchema={SyncAction}
      reducer={syncReducer}
      initialState={createBaseState({
        results: exampleSyncResults,
        members: exampleSyncResults.map((r) => r.name),
        nestedMegarepos: ['effect-utils'],
        generatedFiles: ['flake.nix', '.envrc'],
      })}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}

export const DryRun: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={SyncView}
      stateSchema={SyncState}
      actionSchema={SyncAction}
      reducer={syncReducer}
      initialState={createBaseState({
        options: { dryRun: true, frozen: false, pull: false, deep: false },
        results: [
          { name: 'new-repo', status: 'cloned', ref: 'main' },
          { name: 'effect', status: 'synced', ref: 'main' },
          { name: 'effect-utils', status: 'already_synced' },
        ],
        members: ['new-repo', 'effect', 'effect-utils'],
        generatedFiles: ['flake.nix'],
      })}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}

export const AllSynced: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={SyncView}
      stateSchema={SyncState}
      actionSchema={SyncAction}
      reducer={syncReducer}
      initialState={createBaseState({
        workspace: { name: 'mr-all-blue', root: '/Users/dev/mr-all-blue' },
        options: { dryRun: true, frozen: false, pull: false, deep: false },
        results: exampleAllSynced,
        members: exampleAllSynced.map((r) => r.name),
      })}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}

export const WithErrors: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={SyncView}
      stateSchema={SyncState}
      actionSchema={SyncAction}
      reducer={syncReducer}
      initialState={createBaseState({
        results: exampleSyncResultsWithErrors,
        members: exampleSyncResultsWithErrors.map((r) => r.name),
      })}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}

export const FrozenMode: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={SyncView}
      stateSchema={SyncState}
      actionSchema={SyncAction}
      reducer={syncReducer}
      initialState={createBaseState({
        workspace: { name: 'ci-workspace', root: '/home/runner/workspace' },
        options: { dryRun: false, frozen: true, pull: false, deep: false },
        results: [
          { name: 'effect', status: 'synced', ref: 'main', commit: 'abc1234' },
          { name: 'effect-utils', status: 'synced', ref: 'main', commit: 'def5678' },
          { name: 'livestore', status: 'cloned', ref: 'v1.0.0', commit: '9876543' },
        ],
        members: ['effect', 'effect-utils', 'livestore'],
      })}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}

export const PullMode: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={SyncView}
      stateSchema={SyncState}
      actionSchema={SyncAction}
      reducer={syncReducer}
      initialState={createBaseState({
        options: { dryRun: false, frozen: false, pull: true, deep: false },
        results: [
          { name: 'effect', status: 'updated', commit: 'abc1234def', previousCommit: '9876543fed' },
          {
            name: 'effect-utils',
            status: 'updated',
            commit: 'def5678abc',
            previousCommit: 'fedcba987',
          },
          { name: 'livestore', status: 'already_synced' },
        ],
        members: ['effect', 'effect-utils', 'livestore'],
      })}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}

export const LockUpdates: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={SyncView}
      stateSchema={SyncState}
      actionSchema={SyncAction}
      reducer={syncReducer}
      initialState={createBaseState({
        results: [
          { name: 'effect', status: 'locked', commit: 'abc1234def', previousCommit: '9876543fed' },
          { name: 'effect-utils', status: 'locked', commit: 'def5678abc', previousCommit: 'fedcba987' },
          { name: 'livestore', status: 'already_synced' },
        ],
        members: ['effect', 'effect-utils', 'livestore'],
      })}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}

export const RemovedMembers: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={SyncView}
      stateSchema={SyncState}
      actionSchema={SyncAction}
      reducer={syncReducer}
      initialState={createBaseState({
        results: [
          { name: 'effect', status: 'synced', ref: 'main' },
          { name: 'old-repo', status: 'removed', message: '/store/old-repo-abc123' },
          { name: 'deprecated', status: 'removed', message: '/store/deprecated-def456' },
        ],
        members: ['effect', 'old-repo', 'deprecated'],
      })}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}

export const SkippedMembers: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={SyncView}
      stateSchema={SyncState}
      actionSchema={SyncAction}
      reducer={syncReducer}
      initialState={createBaseState({
        results: [
          { name: 'effect', status: 'synced', ref: 'main' },
          { name: 'dirty-repo', status: 'skipped', message: 'dirty worktree' },
          { name: 'pinned-repo', status: 'skipped', message: 'pinned' },
          { name: 'private-repo', status: 'skipped', message: 'authentication required' },
        ],
        members: ['effect', 'dirty-repo', 'pinned-repo', 'private-repo'],
      })}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}

export const NestedMegareposHint: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={SyncView}
      stateSchema={SyncState}
      actionSchema={SyncAction}
      reducer={syncReducer}
      initialState={createBaseState({
        options: { dryRun: false, frozen: false, pull: false, deep: false },
        results: [
          { name: 'effect', status: 'synced', ref: 'main' },
          { name: 'effect-utils', status: 'synced', ref: 'main' },
          { name: 'livestore', status: 'synced', ref: 'main' },
        ],
        members: ['effect', 'effect-utils', 'livestore'],
        nestedMegarepos: ['effect-utils', 'livestore'],
      })}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}

export const DeepSyncMode: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={SyncView}
      stateSchema={SyncState}
      actionSchema={SyncAction}
      reducer={syncReducer}
      initialState={createBaseState({
        options: { dryRun: false, frozen: false, pull: false, deep: true },
        results: [
          { name: 'effect', status: 'synced', ref: 'main' },
          { name: 'effect-utils', status: 'synced', ref: 'main' },
          { name: 'livestore', status: 'synced', ref: 'main' },
        ],
        members: ['effect', 'effect-utils', 'livestore'],
        nestedMegarepos: ['effect-utils', 'livestore'],
      })}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}

export const WithGenerators: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={SyncView}
      stateSchema={SyncState}
      actionSchema={SyncAction}
      reducer={syncReducer}
      initialState={createBaseState({
        results: [
          { name: 'effect', status: 'synced', ref: 'main' },
          { name: 'effect-utils', status: 'synced', ref: 'main' },
          { name: 'livestore', status: 'cloned', ref: 'main' },
          { name: 'dotfiles', status: 'already_synced' },
        ],
        members: ['effect', 'effect-utils', 'livestore', 'dotfiles'],
        generatedFiles: [
          'flake.nix',
          'flake.lock',
          '.envrc.generated.megarepo',
          '.vscode/megarepo.code-workspace',
        ],
      })}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}

export const ManyMembers: Story = {
  args: { height: 400 },
  render: (args) => {
    const results = Array.from({ length: 10 }, (_, i) => ({
      name: `repo-${String(i + 1).padStart(2, '0')}`,
      status: 'already_synced' as const,
    }))
    return (
      <TuiStoryPreview
        View={SyncView}
        stateSchema={SyncState}
        actionSchema={SyncAction}
        reducer={syncReducer}
        initialState={createBaseState({
          workspace: { name: 'large-workspace', root: '/Users/dev/large-workspace' },
          results,
          members: results.map((r) => r.name),
        })}
        height={args.height}
        autoRun={false}
        tabs={ALL_TABS}
      />
    )
  },
}

// =============================================================================
// Edge Cases
// =============================================================================

export const FirstSync: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={SyncView}
      stateSchema={SyncState}
      actionSchema={SyncAction}
      reducer={syncReducer}
      initialState={createBaseState({
        workspace: { name: 'new-workspace', root: '/Users/dev/new-workspace' },
        results: [
          { name: 'effect', status: 'cloned', ref: 'main' },
          { name: 'effect-utils', status: 'cloned', ref: 'main' },
          { name: 'livestore', status: 'cloned', ref: 'dev' },
          { name: 'dotfiles', status: 'cloned', ref: 'main' },
        ],
        members: ['effect', 'effect-utils', 'livestore', 'dotfiles'],
        generatedFiles: ['flake.nix', '.envrc.generated.megarepo'],
      })}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}

export const AllErrors: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={SyncView}
      stateSchema={SyncState}
      actionSchema={SyncAction}
      reducer={syncReducer}
      initialState={createBaseState({
        results: [
          { name: 'effect', status: 'error', message: 'network timeout' },
          { name: 'effect-utils', status: 'error', message: 'authentication failed' },
          { name: 'livestore', status: 'error', message: 'repository not found' },
          { name: 'private-repo', status: 'error', message: 'permission denied' },
        ],
        members: ['effect', 'effect-utils', 'livestore', 'private-repo'],
      })}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}

export const MixedSkipped: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={SyncView}
      stateSchema={SyncState}
      actionSchema={SyncAction}
      reducer={syncReducer}
      initialState={createBaseState({
        results: [
          { name: 'effect', status: 'already_synced' },
          { name: 'dirty-repo', status: 'skipped', message: '5 uncommitted changes' },
          { name: 'pinned-repo', status: 'skipped', message: 'pinned to v1.0.0' },
          { name: 'auth-repo', status: 'skipped', message: 'authentication required' },
          { name: 'missing-ref', status: 'skipped', message: 'ref feature/x not found' },
        ],
        members: ['effect', 'dirty-repo', 'pinned-repo', 'auth-repo', 'missing-ref'],
      })}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}

export const DeepSyncHint: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={SyncView}
      stateSchema={SyncState}
      actionSchema={SyncAction}
      reducer={syncReducer}
      initialState={createBaseState({
        workspace: { name: 'mr-all-blue', root: '/Users/dev/mr-all-blue' },
        options: { dryRun: false, frozen: false, pull: false, deep: false },
        results: [
          { name: 'effect', status: 'synced', ref: 'main' },
          { name: 'effect-utils', status: 'synced', ref: 'main' },
          { name: 'livestore', status: 'synced', ref: 'dev' },
          { name: 'dotfiles', status: 'already_synced' },
        ],
        members: ['effect', 'effect-utils', 'livestore', 'dotfiles'],
        nestedMegarepos: ['effect-utils', 'livestore', 'dotfiles'],
      })}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}

export const SingleMember: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={SyncView}
      stateSchema={SyncState}
      actionSchema={SyncAction}
      reducer={syncReducer}
      initialState={createBaseState({
        results: [{ name: 'effect', status: 'synced', ref: 'main' }],
        members: ['effect'],
      })}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}

export const RefChanges: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={SyncView}
      stateSchema={SyncState}
      actionSchema={SyncAction}
      reducer={syncReducer}
      initialState={createBaseState({
        options: { dryRun: false, frozen: false, pull: true, deep: false },
        results: [
          { name: 'effect', status: 'synced', ref: 'v3.1.0' },
          { name: 'effect-utils', status: 'updated', commit: 'abc1234', previousCommit: 'def5678' },
          { name: 'livestore', status: 'updated', commit: '1234567', previousCommit: '9876543' },
        ],
        members: ['effect', 'effect-utils', 'livestore'],
      })}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}

export const LongNames: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={SyncView}
      stateSchema={SyncState}
      actionSchema={SyncAction}
      reducer={syncReducer}
      initialState={createBaseState({
        workspace: {
          name: 'organization-name/extremely-long-workspace-name-for-testing',
          root: '/Users/dev/extremely-long-path-to-workspace-directory-for-testing-purposes',
        },
        results: [
          {
            name: '@organization/extremely-long-package-name-for-testing',
            status: 'synced',
            ref: 'main',
          },
          { name: '@another-org/another-very-long-package-name', status: 'already_synced' },
          { name: 'short', status: 'cloned', ref: 'feature/very-long-branch-name-for-testing' },
        ],
        members: [
          '@organization/extremely-long-package-name-for-testing',
          '@another-org/another-very-long-package-name',
          'short',
        ],
      })}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}

// =============================================================================
// Progress Stories (Syncing phase)
// =============================================================================

export const SyncInProgress: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={SyncView}
      stateSchema={SyncState}
      actionSchema={SyncAction}
      reducer={syncReducer}
      initialState={createBaseState({
        phase: 'syncing',
        members: ['effect', 'effect-utils', 'livestore', 'dotfiles'],
        activeMember: 'effect-utils',
        results: [{ name: 'effect', status: 'synced', ref: 'main' }],
      })}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}

export const Interrupted: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={SyncView}
      stateSchema={SyncState}
      actionSchema={SyncAction}
      reducer={syncReducer}
      initialState={createBaseState({
        phase: 'interrupted',
        members: ['effect', 'effect-utils', 'livestore', 'dotfiles'],
        results: [
          { name: 'effect', status: 'synced', ref: 'main' },
          { name: 'effect-utils', status: 'cloned', ref: 'main' },
        ],
      })}
      height={args.height}
      autoRun={false}
      tabs={ALL_TABS}
    />
  ),
}

// =============================================================================
// Animated Story
// =============================================================================

const syncTimeline: Array<{ at: number; action: typeof SyncAction.Type }> = [
  // Start syncing
  {
    at: 0,
    action: {
      _tag: 'SetState',
      state: createBaseState({
        phase: 'syncing',
        members: ['effect', 'effect-utils', 'livestore', 'dotfiles'],
        activeMember: 'effect',
        results: [],
      }),
    },
  },

  // First result
  {
    at: 800,
    action: {
      _tag: 'SetState',
      state: createBaseState({
        phase: 'syncing',
        members: ['effect', 'effect-utils', 'livestore', 'dotfiles'],
        activeMember: 'effect-utils',
        results: [{ name: 'effect', status: 'synced', ref: 'main' }],
      }),
    },
  },

  // Second result
  {
    at: 1600,
    action: {
      _tag: 'SetState',
      state: createBaseState({
        phase: 'syncing',
        members: ['effect', 'effect-utils', 'livestore', 'dotfiles'],
        activeMember: 'livestore',
        results: [
          { name: 'effect', status: 'synced', ref: 'main' },
          { name: 'effect-utils', status: 'cloned', ref: 'main' },
        ],
      }),
    },
  },

  // Third result
  {
    at: 2400,
    action: {
      _tag: 'SetState',
      state: createBaseState({
        phase: 'syncing',
        members: ['effect', 'effect-utils', 'livestore', 'dotfiles'],
        activeMember: 'dotfiles',
        results: [
          { name: 'effect', status: 'synced', ref: 'main' },
          { name: 'effect-utils', status: 'cloned', ref: 'main' },
          { name: 'livestore', status: 'updated', commit: 'abc1234', previousCommit: 'def5678' },
        ],
      }),
    },
  },

  // Complete
  {
    at: 3200,
    action: {
      _tag: 'SetState',
      state: createBaseState({
        phase: 'complete',
        members: ['effect', 'effect-utils', 'livestore', 'dotfiles'],
        results: [
          { name: 'effect', status: 'synced', ref: 'main' },
          { name: 'effect-utils', status: 'cloned', ref: 'main' },
          { name: 'livestore', status: 'updated', commit: 'abc1234', previousCommit: 'def5678' },
          { name: 'dotfiles', status: 'already_synced' },
        ],
        generatedFiles: ['flake.nix', '.envrc'],
        nestedMegarepos: ['effect-utils'],
      }),
    },
  },
]

export const AnimatedSync: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={SyncView}
      stateSchema={SyncState}
      actionSchema={SyncAction}
      reducer={syncReducer}
      initialState={createBaseState({ phase: 'idle' })}
      timeline={syncTimeline}
      autoRun={true}
      playbackSpeed={1}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}
