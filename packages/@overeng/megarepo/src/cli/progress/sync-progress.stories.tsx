/**
 * Sync Progress Stories
 *
 * Timeline-based stories for the sync progress UI using TuiStoryPreview.
 * Demonstrates state progressions during sync operations.
 * Uses the same schemas and view as production code from sync-app.tsx.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview, type OutputTab } from '@overeng/tui-react/storybook'

import {
  SyncProgressState,
  SyncProgressAction,
  syncProgressReducer,
  SyncProgressView,
  type SyncProgressState as SyncProgressStateType,
  type SyncProgressAction as SyncProgressActionType,
} from './sync-app.tsx'

// =============================================================================
// Initial States
// =============================================================================

const createInitialState = (members: string[], options?: { modes?: string[] }): SyncProgressStateType => ({
  title: 'mr-workspace',
  subtitle: '/Users/dev/workspace',
  modes: options?.modes,
  items: members.map((name) => ({
    id: name,
    label: name,
    status: 'pending' as const,
  })),
  logs: [],
  startTime: Date.now(),
  isComplete: false,
})

const members = ['effect', 'effect-utils', 'livestore', 'dotfiles', 'schickling.dev']

// =============================================================================
// Timelines
// =============================================================================

/** Full sync timeline - fresh workspace sync */
const fullSyncTimeline: Array<{ at: number; action: SyncProgressActionType }> = [
  // Start syncing effect
  { at: 200, action: { _tag: 'SetItemStatus', id: 'effect', status: 'active', message: 'cloning...' } },
  { at: 400, action: { _tag: 'AddLog', type: 'info', message: 'Cloning effect from github.com/Effect-TS/effect' } },

  // effect done, start effect-utils
  { at: 1200, action: { _tag: 'SetItemStatus', id: 'effect', status: 'success', message: 'cloned (main)' } },
  { at: 1200, action: { _tag: 'SetItemStatus', id: 'effect-utils', status: 'active', message: 'cloning...' } },

  // effect-utils done, start livestore
  { at: 2000, action: { _tag: 'SetItemStatus', id: 'effect-utils', status: 'success', message: 'cloned (main)' } },
  { at: 2000, action: { _tag: 'SetItemStatus', id: 'livestore', status: 'active', message: 'cloning...' } },

  // livestore done, start dotfiles
  { at: 2800, action: { _tag: 'SetItemStatus', id: 'livestore', status: 'success', message: 'cloned (main)' } },
  { at: 2800, action: { _tag: 'SetItemStatus', id: 'dotfiles', status: 'active', message: 'cloning...' } },

  // dotfiles done, start schickling.dev
  { at: 3400, action: { _tag: 'SetItemStatus', id: 'dotfiles', status: 'success', message: 'cloned (main)' } },
  { at: 3400, action: { _tag: 'SetItemStatus', id: 'schickling.dev', status: 'active', message: 'cloning...' } },

  // All done
  { at: 4000, action: { _tag: 'SetItemStatus', id: 'schickling.dev', status: 'success', message: 'cloned (main)' } },
  { at: 4200, action: { _tag: 'AddLog', type: 'info', message: 'Generated flake.nix' } },
  { at: 4400, action: { _tag: 'SetComplete' } },
]

/** Incremental sync timeline - some already synced */
const incrementalSyncTimeline: Array<{ at: number; action: SyncProgressActionType }> = [
  // effect already synced
  { at: 200, action: { _tag: 'SetItemStatus', id: 'effect', status: 'success' } },

  // effect-utils needs update
  { at: 400, action: { _tag: 'SetItemStatus', id: 'effect-utils', status: 'active', message: 'updating...' } },
  { at: 1000, action: { _tag: 'SetItemStatus', id: 'effect-utils', status: 'success', message: 'updated → abc1234' } },

  // livestore already synced
  { at: 1200, action: { _tag: 'SetItemStatus', id: 'livestore', status: 'success' } },

  // dotfiles skipped (dirty)
  { at: 1400, action: { _tag: 'AddLog', type: 'warn', message: 'dotfiles has uncommitted changes, skipping' } },
  { at: 1400, action: { _tag: 'SetItemStatus', id: 'dotfiles', status: 'skipped', message: 'dirty worktree' } },

  // schickling.dev already synced
  { at: 1600, action: { _tag: 'SetItemStatus', id: 'schickling.dev', status: 'success' } },

  // Done
  { at: 1800, action: { _tag: 'SetComplete' } },
]

/** Error scenario timeline */
const errorSyncTimeline: Array<{ at: number; action: SyncProgressActionType }> = [
  // effect succeeds
  { at: 200, action: { _tag: 'SetItemStatus', id: 'effect', status: 'active', message: 'syncing...' } },
  { at: 800, action: { _tag: 'SetItemStatus', id: 'effect', status: 'success', message: 'synced (main)' } },

  // effect-utils fails
  { at: 1000, action: { _tag: 'SetItemStatus', id: 'effect-utils', status: 'active', message: 'syncing...' } },
  { at: 1800, action: { _tag: 'AddLog', type: 'error', message: 'effect-utils: network timeout after 30s' } },
  { at: 1800, action: { _tag: 'SetItemStatus', id: 'effect-utils', status: 'error', message: 'network timeout' } },

  // Continue with others
  { at: 2000, action: { _tag: 'SetItemStatus', id: 'livestore', status: 'active', message: 'syncing...' } },
  { at: 2600, action: { _tag: 'SetItemStatus', id: 'livestore', status: 'success', message: 'synced (main)' } },

  // dotfiles fails too
  { at: 2800, action: { _tag: 'SetItemStatus', id: 'dotfiles', status: 'active', message: 'syncing...' } },
  { at: 3200, action: { _tag: 'AddLog', type: 'error', message: 'dotfiles: authentication failed' } },
  { at: 3200, action: { _tag: 'SetItemStatus', id: 'dotfiles', status: 'error', message: 'auth failed' } },

  // Last one succeeds
  { at: 3400, action: { _tag: 'SetItemStatus', id: 'schickling.dev', status: 'active', message: 'syncing...' } },
  { at: 4000, action: { _tag: 'SetItemStatus', id: 'schickling.dev', status: 'success', message: 'synced (main)' } },

  // Done with errors
  { at: 4200, action: { _tag: 'SetComplete' } },
]

// =============================================================================
// Story Meta
// =============================================================================

const ALL_TABS: OutputTab[] = ['tty', 'ci', 'log', 'json', 'ndjson']

const meta: Meta = {
  title: 'CLI/Sync Progress',
  args: {
    // Bypass TerminalPreview decorator - TuiStoryPreview handles its own terminal rendering
    renderMode: 'string',
  },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: `
Sync progress UI demonstrating real-time updates during \`mr sync\` command execution.

**Features:**
- Real-time task status updates (pending → active → success/error/skipped)
- Log streaming via Static component
- Multiple sync modes (dry-run, frozen, pull, deep)
- Error handling with detailed messages

**CLI Usage:**
\`\`\`bash
mr sync                    # Normal sync
mr sync --dry-run          # Preview changes
mr sync --frozen           # CI mode, exact commits
mr sync --pull             # Update to latest
mr sync --deep             # Include nested megarepos
\`\`\`

**Architecture:**
This uses the \`createTuiApp\` pattern with Effect Schema for type-safe state management.
The same schemas and view component are used in both production and Storybook.
        `,
      },
    },
  },
}

export default meta

// =============================================================================
// Stories
// =============================================================================

type Story = StoryObj<{
  autoRun: boolean
  playbackSpeed: number
  height: number
}>

/** Full sync - fresh workspace with all repos cloning */
export const FullSync: Story = {
  args: {
    autoRun: true,
    playbackSpeed: 1,
    height: 400,
  },
  argTypes: {
    autoRun: { control: 'boolean', description: 'Auto-start timeline' },
    playbackSpeed: { control: { type: 'range', min: 0.5, max: 3, step: 0.5 } },
    height: { control: { type: 'range', min: 200, max: 500, step: 50 } },
  },
  render: (args) => (
    <TuiStoryPreview
      View={SyncProgressView}
      stateSchema={SyncProgressState}
      actionSchema={SyncProgressAction}
      reducer={syncProgressReducer}
      initialState={createInitialState(members)}
      timeline={fullSyncTimeline}
      autoRun={args.autoRun}
      playbackSpeed={args.playbackSpeed}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}

/** Incremental sync - some repos already up to date */
export const IncrementalSync: Story = {
  args: {
    autoRun: true,
    playbackSpeed: 1,
    height: 400,
  },
  render: (args) => (
    <TuiStoryPreview
      View={SyncProgressView}
      stateSchema={SyncProgressState}
      actionSchema={SyncProgressAction}
      reducer={syncProgressReducer}
      initialState={createInitialState(members)}
      timeline={incrementalSyncTimeline}
      autoRun={args.autoRun}
      playbackSpeed={args.playbackSpeed}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}

/** Error scenario - network and auth failures */
export const WithErrors: Story = {
  args: {
    autoRun: true,
    playbackSpeed: 1,
    height: 400,
  },
  render: (args) => (
    <TuiStoryPreview
      View={SyncProgressView}
      stateSchema={SyncProgressState}
      actionSchema={SyncProgressAction}
      reducer={syncProgressReducer}
      initialState={createInitialState(members)}
      timeline={errorSyncTimeline}
      autoRun={args.autoRun}
      playbackSpeed={args.playbackSpeed}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}

/** Dry run mode - preview what would happen */
export const DryRunMode: Story = {
  args: {
    autoRun: true,
    playbackSpeed: 1.5,
    height: 400,
  },
  render: (args) => (
    <TuiStoryPreview
      View={SyncProgressView}
      stateSchema={SyncProgressState}
      actionSchema={SyncProgressAction}
      reducer={syncProgressReducer}
      initialState={createInitialState(members, { modes: ['dry run'] })}
      timeline={fullSyncTimeline}
      autoRun={args.autoRun}
      playbackSpeed={args.playbackSpeed}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}

/** Frozen mode - CI exact commits */
export const FrozenMode: Story = {
  args: {
    autoRun: true,
    playbackSpeed: 1.5,
    height: 400,
  },
  render: (args) => (
    <TuiStoryPreview
      View={SyncProgressView}
      stateSchema={SyncProgressState}
      actionSchema={SyncProgressAction}
      reducer={syncProgressReducer}
      initialState={createInitialState(members, { modes: ['frozen'] })}
      timeline={incrementalSyncTimeline}
      autoRun={args.autoRun}
      playbackSpeed={args.playbackSpeed}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}

// =============================================================================
// Static State Stories (no timeline)
// =============================================================================

/** All pending - initial state before sync starts */
export const AllPending: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={SyncProgressView}
      stateSchema={SyncProgressState}
      actionSchema={SyncProgressAction}
      reducer={syncProgressReducer}
      initialState={createInitialState(members)}
      height={args.height}
      autoRun={false}
      tabs={['tty', 'ci', 'log']}
    />
  ),
}

/** In progress - mixed states */
export const InProgress: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={SyncProgressView}
      stateSchema={SyncProgressState}
      actionSchema={SyncProgressAction}
      reducer={syncProgressReducer}
      initialState={{
        title: 'mr-workspace',
        subtitle: '/Users/dev/workspace',
        items: [
          { id: 'effect', label: 'effect', status: 'success', message: 'synced (main)' },
          { id: 'effect-utils', label: 'effect-utils', status: 'success', message: 'updated → abc1234' },
          { id: 'livestore', label: 'livestore', status: 'active', message: 'syncing...' },
          { id: 'dotfiles', label: 'dotfiles', status: 'pending' },
          { id: 'schickling.dev', label: 'schickling.dev', status: 'pending' },
        ],
        logs: [{ id: 'log-1', type: 'info', message: 'Syncing livestore from github.com/livestore/livestore' }],
        startTime: Date.now() - 3000,
        isComplete: false,
      }}
      height={args.height}
      autoRun={false}
      tabs={['tty', 'ci', 'log']}
    />
  ),
}

/** Complete - all done successfully */
export const Complete: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={SyncProgressView}
      stateSchema={SyncProgressState}
      actionSchema={SyncProgressAction}
      reducer={syncProgressReducer}
      initialState={{
        title: 'mr-workspace',
        subtitle: '/Users/dev/workspace',
        items: [
          { id: 'effect', label: 'effect', status: 'success', message: 'synced (main)' },
          { id: 'effect-utils', label: 'effect-utils', status: 'success', message: 'updated → abc1234' },
          { id: 'livestore', label: 'livestore', status: 'success', message: 'cloned (main)' },
          { id: 'dotfiles', label: 'dotfiles', status: 'success' },
          { id: 'schickling.dev', label: 'schickling.dev', status: 'success' },
        ],
        logs: [
          { id: 'log-1', type: 'info', message: 'Generated flake.nix' },
          { id: 'log-2', type: 'info', message: 'Generated .envrc' },
        ],
        startTime: Date.now() - 5000,
        isComplete: true,
      }}
      height={args.height}
      autoRun={false}
      tabs={['tty', 'ci', 'log', 'json']}
    />
  ),
}

/** Complete with errors - finished but some failed */
export const CompleteWithErrors: Story = {
  args: { height: 400 },
  render: (args) => (
    <TuiStoryPreview
      View={SyncProgressView}
      stateSchema={SyncProgressState}
      actionSchema={SyncProgressAction}
      reducer={syncProgressReducer}
      initialState={{
        title: 'mr-workspace',
        subtitle: '/Users/dev/workspace',
        items: [
          { id: 'effect', label: 'effect', status: 'success', message: 'synced (main)' },
          { id: 'effect-utils', label: 'effect-utils', status: 'error', message: 'network timeout' },
          { id: 'livestore', label: 'livestore', status: 'success', message: 'synced (main)' },
          { id: 'dotfiles', label: 'dotfiles', status: 'skipped', message: 'dirty worktree' },
          { id: 'schickling.dev', label: 'schickling.dev', status: 'error', message: 'auth failed' },
        ],
        logs: [
          { id: 'log-1', type: 'error', message: 'effect-utils: network timeout after 30s' },
          { id: 'log-2', type: 'warn', message: 'dotfiles has uncommitted changes' },
          { id: 'log-3', type: 'error', message: 'schickling.dev: authentication failed' },
        ],
        startTime: Date.now() - 8000,
        isComplete: true,
      }}
      height={args.height}
      autoRun={false}
      tabs={['tty', 'ci', 'log', 'json']}
    />
  ),
}
