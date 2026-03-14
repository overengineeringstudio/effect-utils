/**
 * Result state stories for `mr fetch` — various completion scenarios.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useMemo } from 'react'

import {
  ALL_OUTPUT_TABS,
  commonArgTypes,
  defaultStoryArgs,
  TuiStoryPreview,
} from '@overeng/tui-react/storybook'

import { SyncApp } from '../../mod.ts'
import { SyncView } from '../../view.tsx'
import {
  createBaseState,
  createCommandState,
  createCommandTimeline,
  createTimeline,
  exampleAllSynced,
  exampleSyncResults,
} from '../_fixtures.ts'
import { fetchResults, fetchWithNewBranches } from './_fixtures.ts'

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
  dryRun: boolean
  all: boolean
  verbose: boolean
}

export default {
  component: SyncView,
  title: 'CLI/Fetch/Results',
  parameters: { layout: 'fullscreen' },
  args: {
    ...defaultStoryArgs,
    dryRun: false,
    all: false,
    verbose: false,
  },
  argTypes: {
    ...commonArgTypes,
    dryRun: {
      description: '--dry-run: show what would happen without making changes',
      control: { type: 'boolean' },
    },
    all: {
      description: '--all: sync nested megarepos recursively',
      control: { type: 'boolean' },
    },
    verbose: {
      description: '--verbose: show detailed information',
      control: { type: 'boolean' },
    },
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

/** Mixed sync results — cloned, synced, updated, skipped */
export const MixedResults: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        options: {
          mode: 'fetch' as const,
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
        },
        results: exampleSyncResults,
        members: exampleSyncResults.map((r) => r.name),
        nestedMegarepos: ['effect-utils'],
        generatedFiles: ['flake.nix', '.envrc'],
      }),
      [args.dryRun, args.all, args.verbose],
    )
    return (
      <TuiStoryPreview
        View={SyncView}
        app={SyncApp}
        initialState={createBaseState(
          args.interactive === true ? { _tag: 'Success' } : stateConfig,
        )}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        command={`mr fetch${args.dryRun ? ' --dry-run' : ''}${args.all ? ' --all' : ''}${args.verbose ? ' --verbose' : ''}`}
        {...(args.interactive === true ? { timeline: createTimeline(stateConfig) } : {})}
      />
    )
  },
}

/** All members already synced */
export const AllUpToDate: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        options: {
          mode: 'fetch' as const,
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
        },
        workspace: { name: 'mr-all-blue', root: '/Users/dev/mr-all-blue' },
        results: exampleAllSynced,
        members: exampleAllSynced.map((r) => r.name),
      }),
      [args.dryRun, args.all, args.verbose],
    )
    return (
      <TuiStoryPreview
        View={SyncView}
        app={SyncApp}
        initialState={createBaseState(
          args.interactive === true ? { _tag: 'Success' } : stateConfig,
        )}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        command={`mr fetch${args.dryRun ? ' --dry-run' : ''}${args.all ? ' --all' : ''}${args.verbose ? ' --verbose' : ''}`}
        {...(args.interactive === true ? { timeline: createTimeline(stateConfig) } : {})}
      />
    )
  },
}

/** First fetch — all members cloned */
export const InitialFetch: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        options: {
          mode: 'fetch' as const,
          dryRun: args.dryRun,
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
      [args.dryRun, args.all, args.verbose],
    )
    return (
      <TuiStoryPreview
        View={SyncView}
        app={SyncApp}
        initialState={createBaseState(
          args.interactive === true ? { _tag: 'Success' } : stateConfig,
        )}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        command={`mr fetch${args.dryRun ? ' --dry-run' : ''}${args.all ? ' --all' : ''}${args.verbose ? ' --verbose' : ''}`}
        {...(args.interactive === true ? { timeline: createTimeline(stateConfig) } : {})}
      />
    )
  },
}

/** Members fetched and updated */
export const Updated: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: fetchResults,
        options: {
          mode: 'fetch' as const,
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
        },
      }),
      [args.dryRun, args.all, args.verbose],
    )
    return (
      <TuiStoryPreview
        View={SyncView}
        app={SyncApp}
        initialState={createCommandState({
          mode: 'fetch',
          overrides: args.interactive === true ? { _tag: 'Success', results: [] } : stateConfig,
        })}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        command={`mr fetch${args.dryRun ? ' --dry-run' : ''}${args.all ? ' --all' : ''}${args.verbose ? ' --verbose' : ''}`}
        {...(args.interactive === true
          ? {
              timeline: createCommandTimeline({ mode: 'fetch', finalState: stateConfig }),
            }
          : {})}
      />
    )
  },
}

/** New branches created during fetch */
export const WithNewBranches: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: fetchWithNewBranches,
        options: {
          mode: 'fetch' as const,
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
        },
      }),
      [args.dryRun, args.all, args.verbose],
    )
    return (
      <TuiStoryPreview
        View={SyncView}
        app={SyncApp}
        initialState={createCommandState({
          mode: 'fetch',
          overrides: args.interactive === true ? { _tag: 'Success', results: [] } : stateConfig,
        })}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        command={`mr fetch${args.dryRun ? ' --dry-run' : ''}${args.all ? ' --all' : ''}${args.verbose ? ' --verbose' : ''}`}
        {...(args.interactive === true
          ? {
              timeline: createCommandTimeline({ mode: 'fetch', finalState: stateConfig }),
            }
          : {})}
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
          mode: 'fetch' as const,
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
        },
        results: [
          { name: 'effect', status: 'synced' as const, ref: 'main' },
          { name: 'old-repo', status: 'removed' as const, message: '/store/old-repo-abc123' },
          { name: 'deprecated', status: 'removed' as const, message: '/store/deprecated-def456' },
        ],
        members: ['effect', 'old-repo', 'deprecated'],
      }),
      [args.dryRun, args.all, args.verbose],
    )
    return (
      <TuiStoryPreview
        View={SyncView}
        app={SyncApp}
        initialState={createBaseState(
          args.interactive === true ? { _tag: 'Success' } : stateConfig,
        )}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        command={`mr fetch${args.dryRun ? ' --dry-run' : ''}${args.all ? ' --all' : ''}${args.verbose ? ' --verbose' : ''}`}
        {...(args.interactive === true ? { timeline: createTimeline(stateConfig) } : {})}
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
          mode: 'fetch' as const,
          dryRun: args.dryRun,
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
      [args.dryRun, args.all, args.verbose],
    )
    return (
      <TuiStoryPreview
        View={SyncView}
        app={SyncApp}
        initialState={createBaseState(
          args.interactive === true ? { _tag: 'Success' } : stateConfig,
        )}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        command={`mr fetch${args.dryRun ? ' --dry-run' : ''}${args.all ? ' --all' : ''}${args.verbose ? ' --verbose' : ''}`}
        {...(args.interactive === true ? { timeline: createTimeline(stateConfig) } : {})}
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
          mode: 'fetch' as const,
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
        },
        results: [{ name: 'effect', status: 'synced' as const, ref: 'main' }],
        members: ['effect'],
      }),
      [args.dryRun, args.all, args.verbose],
    )
    return (
      <TuiStoryPreview
        View={SyncView}
        app={SyncApp}
        initialState={createBaseState(
          args.interactive === true ? { _tag: 'Success' } : stateConfig,
        )}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        command={`mr fetch${args.dryRun ? ' --dry-run' : ''}${args.all ? ' --all' : ''}${args.verbose ? ' --verbose' : ''}`}
        {...(args.interactive === true ? { timeline: createTimeline(stateConfig) } : {})}
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
          mode: 'fetch' as const,
          dryRun: args.dryRun,
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
    }, [args.dryRun, args.all, args.verbose])
    return (
      <TuiStoryPreview
        View={SyncView}
        app={SyncApp}
        initialState={createBaseState(
          args.interactive === true ? { _tag: 'Success' } : stateConfig,
        )}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        command={`mr fetch${args.dryRun ? ' --dry-run' : ''}${args.all ? ' --all' : ''}${args.verbose ? ' --verbose' : ''}`}
        {...(args.interactive === true ? { timeline: createTimeline(stateConfig) } : {})}
      />
    )
  },
}

/** Nested megarepos hint */
export const NestedMegarepos: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        options: {
          mode: 'fetch' as const,
          dryRun: args.dryRun,
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
      [args.dryRun, args.all, args.verbose],
    )
    return (
      <TuiStoryPreview
        View={SyncView}
        app={SyncApp}
        initialState={createBaseState(
          args.interactive === true ? { _tag: 'Success' } : stateConfig,
        )}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        command={`mr fetch${args.dryRun ? ' --dry-run' : ''}${args.all ? ' --all' : ''}${args.verbose ? ' --verbose' : ''}`}
        {...(args.interactive === true ? { timeline: createTimeline(stateConfig) } : {})}
      />
    )
  },
}

/** Dry run — preview what would be fetched */
export const DryRun: Story = {
  args: { dryRun: true },
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: fetchResults,
        options: {
          mode: 'fetch' as const,
          dryRun: true,
          all: args.all,
          verbose: args.verbose,
        },
      }),
      [args.all, args.verbose],
    )
    return (
      <TuiStoryPreview
        View={SyncView}
        app={SyncApp}
        initialState={createCommandState({
          mode: 'fetch',
          overrides: args.interactive === true ? { _tag: 'Success', results: [] } : stateConfig,
        })}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        command={`mr fetch${args.dryRun ? ' --dry-run' : ''}${args.all ? ' --all' : ''}${args.verbose ? ' --verbose' : ''}`}
        {...(args.interactive === true
          ? {
              timeline: createCommandTimeline({ mode: 'fetch', finalState: stateConfig }),
            }
          : {})}
      />
    )
  },
}
