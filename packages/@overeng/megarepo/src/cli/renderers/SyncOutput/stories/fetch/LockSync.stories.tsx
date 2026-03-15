/**
 * Lock sync stories for `mr fetch` — shows lock file update details.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useMemo } from 'react'

import {
  ALL_OUTPUT_TABS,
  commonArgTypes,
  defaultStoryArgs,
  TuiStoryPreview,
} from '@overeng/tui-react/storybook'

import { flagArgTypes, MEGAREPO_MEMBERS, WORKSPACE } from '../../../_story-constants.ts'
import { SyncApp } from '../../mod.ts'
import { SyncView } from '../../view.tsx'
import {
  createCommandState,
  createCommandTimeline,
  exampleLockSyncResults,
  exampleNestedSyncTrees,
  exampleRefSyncResults,
  exampleSharedSourceSync,
  exampleMixedSyncResults,
  exampleMixedSharedSourceSync,
} from '../_fixtures.ts'
import { fetchFullNixSync, fetchLockSyncResults, fetchResults } from './_fixtures.ts'

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
  dryRun: boolean
  all: boolean
  verbose: boolean
  force: boolean
}

/** Builds syncTree and nestedMegarepos fields based on --all flag */
const nestedFields = (all: boolean) => ({
  nestedMegarepos: all === true ? [] : [...MEGAREPO_MEMBERS],
  syncTree: {
    root: WORKSPACE.root,
    results: fetchResults,
    nestedMegarepos: all === true ? [] : [...MEGAREPO_MEMBERS],
    nestedResults: all === true ? exampleNestedSyncTrees : [],
  },
})

export default {
  component: SyncView,
  title: 'CLI/Fetch/Lock Sync',
  parameters: { layout: 'fullscreen' },
  args: {
    ...defaultStoryArgs,
    dryRun: false,
    all: false,
    verbose: true,
    force: false,
  },
  argTypes: {
    ...commonArgTypes,
    dryRun: flagArgTypes.dryRun,
    all: flagArgTypes.all,
    verbose: flagArgTypes.verbose,
    force: flagArgTypes.force,
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

/** Fetch with lock sync results (flake.lock/devenv.lock) */
export const WithLockSync: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: fetchResults,
        lockSyncResults: exampleLockSyncResults,
        ...nestedFields(args.all),
        options: {
          mode: 'fetch' as const,
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
          force: args.force,
        },
      }),
      [args.dryRun, args.all, args.verbose, args.force],
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
        cwd="~/workspace"
        command={`mr fetch${args.dryRun === true ? ' --dry-run' : ''}${args.all === true ? ' --all' : ''}${args.verbose === true ? ' --verbose' : ''}${args.force === true ? ' --force' : ''}`}
        {...(args.interactive === true
          ? {
              timeline: createCommandTimeline({ mode: 'fetch', finalState: stateConfig }),
            }
          : {})}
      />
    )
  },
}

/** Fetch with lock input sync results (including flake.nix/devenv.yaml source file updates) */
export const WithLockInputSync: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: fetchResults,
        lockSyncResults: fetchLockSyncResults,
        ...nestedFields(args.all),
        options: {
          mode: 'fetch' as const,
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
          force: args.force,
        },
      }),
      [args.dryRun, args.all, args.verbose, args.force],
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
        cwd="~/workspace"
        command={`mr fetch${args.dryRun === true ? ' --dry-run' : ''}${args.all === true ? ' --all' : ''}${args.verbose === true ? ' --verbose' : ''}${args.force === true ? ' --force' : ''}`}
        {...(args.interactive === true
          ? {
              timeline: createCommandTimeline({ mode: 'fetch', finalState: stateConfig }),
            }
          : {})}
      />
    )
  },
}

/** Fetch with full nix lock sync including source file (flake.nix, devenv.yaml) updates */
export const WithSourceFileSync: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: fetchResults,
        lockSyncResults: fetchFullNixSync,
        ...nestedFields(args.all),
        options: {
          mode: 'fetch' as const,
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
          force: args.force,
        },
      }),
      [args.dryRun, args.all, args.verbose, args.force],
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
        cwd="~/workspace"
        command={`mr fetch${args.dryRun === true ? ' --dry-run' : ''}${args.all === true ? ' --all' : ''}${args.verbose === true ? ' --verbose' : ''}${args.force === true ? ' --force' : ''}`}
        {...(args.interactive === true
          ? {
              timeline: createCommandTimeline({ mode: 'fetch', finalState: stateConfig }),
            }
          : {})}
      />
    )
  },
}

/** Fetch with ref propagation (branch changes across members) */
export const WithRefSync: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: fetchResults,
        lockSyncResults: exampleRefSyncResults,
        ...nestedFields(args.all),
        options: {
          mode: 'fetch' as const,
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
          force: args.force,
        },
      }),
      [args.dryRun, args.all, args.verbose, args.force],
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
        cwd="~/workspace"
        command={`mr fetch${args.dryRun === true ? ' --dry-run' : ''}${args.all === true ? ' --all' : ''}${args.verbose === true ? ' --verbose' : ''}${args.force === true ? ' --force' : ''}`}
        {...(args.interactive === true
          ? {
              timeline: createCommandTimeline({ mode: 'fetch', finalState: stateConfig }),
            }
          : {})}
      />
    )
  },
}

/** Fetch with shared lock source propagation (e.g. devenv version) */
export const WithSharedSourceSync: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: fetchResults,
        lockSyncResults: [],
        sharedSourceUpdates: exampleSharedSourceSync,
        ...nestedFields(args.all),
        options: {
          mode: 'fetch' as const,
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
          force: args.force,
        },
      }),
      [args.dryRun, args.all, args.verbose, args.force],
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
        cwd="~/workspace"
        command={`mr fetch${args.dryRun === true ? ' --dry-run' : ''}${args.all === true ? ' --all' : ''}${args.verbose === true ? ' --verbose' : ''}${args.force === true ? ' --force' : ''}`}
        {...(args.interactive === true
          ? {
              timeline: createCommandTimeline({ mode: 'fetch', finalState: stateConfig }),
            }
          : {})}
      />
    )
  },
}

/** Fetch with all three update types: rev sync, ref sync, and shared source sync */
export const WithMixedSync: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: fetchResults,
        lockSyncResults: exampleMixedSyncResults,
        sharedSourceUpdates: exampleMixedSharedSourceSync,
        ...nestedFields(args.all),
        options: {
          mode: 'fetch' as const,
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
          force: args.force,
        },
      }),
      [args.dryRun, args.all, args.verbose, args.force],
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
        cwd="~/workspace"
        command={`mr fetch${args.dryRun === true ? ' --dry-run' : ''}${args.all === true ? ' --all' : ''}${args.verbose === true ? ' --verbose' : ''}${args.force === true ? ' --force' : ''}`}
        {...(args.interactive === true
          ? {
              timeline: createCommandTimeline({ mode: 'fetch', finalState: stateConfig }),
            }
          : {})}
      />
    )
  },
}
