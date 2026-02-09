/**
 * Result state stories for SyncOutput - various completion scenarios.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useMemo } from 'react'

import {
  ALL_OUTPUT_TABS,
  commonArgTypes,
  defaultStoryArgs,
  TuiStoryPreview,
} from '@overeng/tui-react/storybook'

import { SyncApp } from '../mod.ts'
import { SyncView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
  dryRun: boolean
  frozen: boolean
  pull: boolean
  all: boolean
  verbose: boolean
}

export default {
  component: SyncView,
  title: 'CLI/Sync/Results',
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    ...defaultStoryArgs,
    dryRun: false,
    frozen: false,
    pull: false,
    all: false,
    verbose: false,
  },
  argTypes: {
    ...commonArgTypes,
    dryRun: {
      description: '--dry-run flag: show what would happen without making changes',
      control: { type: 'boolean' },
    },
    frozen: {
      description: '--frozen flag: use exact commits from lock file (CI mode)',
      control: { type: 'boolean' },
    },
    pull: {
      description: '--pull flag: update to latest commits',
      control: { type: 'boolean' },
    },
    all: {
      description: '--all flag: sync nested megarepos recursively',
      control: { type: 'boolean' },
    },
    verbose: {
      description: '--verbose flag: show detailed lock sync information',
      control: { type: 'boolean' },
    },
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

/** Mixed sync results - cloned, synced, updated, skipped */
export const MixedResults: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        options: {
          dryRun: args.dryRun,
          frozen: args.frozen,
          pull: args.pull,
          all: args.all,
          verbose: args.verbose,
        },
        results: fixtures.exampleSyncResults,
        members: fixtures.exampleSyncResults.map((r) => r.name),
        nestedMegarepos: ['effect-utils'],
        generatedFiles: ['flake.nix', '.envrc'],
      }),
      [args.dryRun, args.frozen, args.pull, args.all, args.verbose],
    )
    return (
      <TuiStoryPreview
        View={SyncView}
        app={SyncApp}
        initialState={fixtures.createBaseState(
          args.interactive ? { _tag: 'Success' } : stateConfig,
        )}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive ? { timeline: fixtures.createTimeline(stateConfig) } : {})}
      />
    )
  },
}

/** All members already synced */
export const AllSynced: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        options: {
          dryRun: args.dryRun,
          frozen: args.frozen,
          pull: args.pull,
          all: args.all,
          verbose: args.verbose,
        },
        workspace: { name: 'mr-all-blue', root: '/Users/dev/mr-all-blue' },
        results: fixtures.exampleAllSynced,
        members: fixtures.exampleAllSynced.map((r) => r.name),
      }),
      [args.dryRun, args.frozen, args.pull, args.all, args.verbose],
    )
    return (
      <TuiStoryPreview
        View={SyncView}
        app={SyncApp}
        initialState={fixtures.createBaseState(
          args.interactive ? { _tag: 'Success' } : stateConfig,
        )}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive ? { timeline: fixtures.createTimeline(stateConfig) } : {})}
      />
    )
  },
}

/** First sync - all members cloned */
export const FirstSync: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        options: {
          dryRun: args.dryRun,
          frozen: args.frozen,
          pull: args.pull,
          all: args.all,
          verbose: args.verbose,
        },
        workspace: { name: 'new-workspace', root: '/Users/dev/new-workspace' },
        results: [
          { name: 'effect', status: 'cloned' as const, ref: 'main' },
          { name: 'effect-utils', status: 'cloned' as const, ref: 'main' },
          { name: 'livestore', status: 'cloned' as const, ref: 'dev' },
          { name: 'dotfiles', status: 'cloned' as const, ref: 'main' },
        ],
        members: ['effect', 'effect-utils', 'livestore', 'dotfiles'],
        generatedFiles: ['flake.nix'],
      }),
      [args.dryRun, args.frozen, args.pull, args.all, args.verbose],
    )
    return (
      <TuiStoryPreview
        View={SyncView}
        app={SyncApp}
        initialState={fixtures.createBaseState(
          args.interactive ? { _tag: 'Success' } : stateConfig,
        )}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive ? { timeline: fixtures.createTimeline(stateConfig) } : {})}
      />
    )
  },
}

/** Lock updates from local changes */
export const LockUpdates: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        options: {
          dryRun: args.dryRun,
          frozen: args.frozen,
          pull: args.pull,
          all: args.all,
          verbose: args.verbose,
        },
        results: [
          {
            name: 'effect',
            status: 'locked' as const,
            commit: 'abc1234def',
            previousCommit: '9876543fed',
          },
          {
            name: 'effect-utils',
            status: 'locked' as const,
            commit: 'def5678abc',
            previousCommit: 'fedcba987',
          },
          { name: 'livestore', status: 'already_synced' as const },
        ],
        members: ['effect', 'effect-utils', 'livestore'],
      }),
      [args.dryRun, args.frozen, args.pull, args.all, args.verbose],
    )
    return (
      <TuiStoryPreview
        View={SyncView}
        app={SyncApp}
        initialState={fixtures.createBaseState(
          args.interactive ? { _tag: 'Success' } : stateConfig,
        )}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive ? { timeline: fixtures.createTimeline(stateConfig) } : {})}
      />
    )
  },
}

/** Members removed from config */
export const RemovedMembers: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        options: {
          dryRun: args.dryRun,
          frozen: args.frozen,
          pull: args.pull,
          all: args.all,
          verbose: args.verbose,
        },
        results: [
          { name: 'effect', status: 'synced' as const, ref: 'main' },
          {
            name: 'old-repo',
            status: 'removed' as const,
            message: '/store/old-repo-abc123',
          },
          {
            name: 'deprecated',
            status: 'removed' as const,
            message: '/store/deprecated-def456',
          },
        ],
        members: ['effect', 'old-repo', 'deprecated'],
      }),
      [args.dryRun, args.frozen, args.pull, args.all, args.verbose],
    )
    return (
      <TuiStoryPreview
        View={SyncView}
        app={SyncApp}
        initialState={fixtures.createBaseState(
          args.interactive ? { _tag: 'Success' } : stateConfig,
        )}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive ? { timeline: fixtures.createTimeline(stateConfig) } : {})}
      />
    )
  },
}

/** With generated files */
export const WithGenerators: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        options: {
          dryRun: args.dryRun,
          frozen: args.frozen,
          pull: args.pull,
          all: args.all,
          verbose: args.verbose,
        },
        results: [
          { name: 'effect', status: 'synced' as const, ref: 'main' },
          { name: 'effect-utils', status: 'synced' as const, ref: 'main' },
          { name: 'livestore', status: 'cloned' as const, ref: 'main' },
          { name: 'dotfiles', status: 'already_synced' as const },
        ],
        members: ['effect', 'effect-utils', 'livestore', 'dotfiles'],
        generatedFiles: ['flake.nix', 'flake.lock', '.vscode/megarepo.code-workspace'],
      }),
      [args.dryRun, args.frozen, args.pull, args.all, args.verbose],
    )
    return (
      <TuiStoryPreview
        View={SyncView}
        app={SyncApp}
        initialState={fixtures.createBaseState(
          args.interactive ? { _tag: 'Success' } : stateConfig,
        )}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive ? { timeline: fixtures.createTimeline(stateConfig) } : {})}
      />
    )
  },
}

/** Single member workspace */
export const SingleMember: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        options: {
          dryRun: args.dryRun,
          frozen: args.frozen,
          pull: args.pull,
          all: args.all,
          verbose: args.verbose,
        },
        results: [{ name: 'effect', status: 'synced' as const, ref: 'main' }],
        members: ['effect'],
      }),
      [args.dryRun, args.frozen, args.pull, args.all, args.verbose],
    )
    return (
      <TuiStoryPreview
        View={SyncView}
        app={SyncApp}
        initialState={fixtures.createBaseState(
          args.interactive ? { _tag: 'Success' } : stateConfig,
        )}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive ? { timeline: fixtures.createTimeline(stateConfig) } : {})}
      />
    )
  },
}

/** Large workspace with many members */
export const ManyMembers: Story = {
  render: (args) => {
    const stateConfig = useMemo(() => {
      const results = Array.from({ length: 10 }, (_, i) => ({
        name: `repo-${String(i + 1).padStart(2, '0')}`,
        status: 'already_synced' as const,
      }))
      return {
        options: {
          dryRun: args.dryRun,
          frozen: args.frozen,
          pull: args.pull,
          all: args.all,
          verbose: args.verbose,
        },
        workspace: {
          name: 'large-workspace',
          root: '/Users/dev/large-workspace',
        },
        results,
        members: results.map((r) => r.name),
      }
    }, [args.dryRun, args.frozen, args.pull, args.all, args.verbose])
    return (
      <TuiStoryPreview
        View={SyncView}
        app={SyncApp}
        initialState={fixtures.createBaseState(
          args.interactive ? { _tag: 'Success' } : stateConfig,
        )}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive ? { timeline: fixtures.createTimeline(stateConfig) } : {})}
      />
    )
  },
}

/** Nested megarepos hint (shows when not using --all) */
export const NestedMegarepos: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        options: {
          dryRun: args.dryRun,
          frozen: args.frozen,
          pull: args.pull,
          all: args.all,
          verbose: args.verbose,
        },
        results: [
          { name: 'effect', status: 'synced' as const, ref: 'main' },
          { name: 'effect-utils', status: 'synced' as const, ref: 'main' },
          { name: 'livestore', status: 'synced' as const, ref: 'main' },
        ],
        members: ['effect', 'effect-utils', 'livestore'],
        nestedMegarepos: ['effect-utils', 'livestore'],
      }),
      [args.dryRun, args.frozen, args.pull, args.all, args.verbose],
    )
    return (
      <TuiStoryPreview
        View={SyncView}
        app={SyncApp}
        initialState={fixtures.createBaseState(
          args.interactive ? { _tag: 'Success' } : stateConfig,
        )}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive ? { timeline: fixtures.createTimeline(stateConfig) } : {})}
      />
    )
  },
}

/** Lock sync results - shows inline badge and verbose expandable section */
export const WithLockSync: Story = {
  args: {
    verbose: true, // Default to verbose to show expandable section
  },
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        options: {
          dryRun: args.dryRun,
          frozen: args.frozen,
          pull: args.pull,
          all: args.all,
          verbose: args.verbose,
        },
        results: [
          { name: 'effect', status: 'synced' as const, ref: 'main' },
          { name: 'effect-utils', status: 'synced' as const, ref: 'main' },
          { name: 'livestore', status: 'already_synced' as const },
          { name: 'dotfiles', status: 'synced' as const, ref: 'main' },
        ],
        members: ['effect', 'effect-utils', 'livestore', 'dotfiles'],
        lockSyncResults: fixtures.exampleLockSyncResults,
      }),
      [args.dryRun, args.frozen, args.pull, args.all, args.verbose],
    )
    return (
      <TuiStoryPreview
        View={SyncView}
        app={SyncApp}
        initialState={fixtures.createBaseState(
          args.interactive ? { _tag: 'Success' } : stateConfig,
        )}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive ? { timeline: fixtures.createTimeline(stateConfig) } : {})}
      />
    )
  },
}
