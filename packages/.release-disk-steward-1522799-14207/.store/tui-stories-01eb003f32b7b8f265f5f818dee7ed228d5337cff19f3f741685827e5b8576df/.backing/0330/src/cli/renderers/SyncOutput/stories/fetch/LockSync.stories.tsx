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

import {
  buildSyncCommand,
  buildSyncOptions,
  flagArgTypes,
  MEGAREPO_MEMBERS,
  WORKSPACE,
} from '../../../_story-constants.ts'
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
import { fetchFullNixSync, fetchLockInputSyncResults, fetchResults } from './_fixtures.ts'

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
const WithLockSyncRender = (args: StoryArgs) => {
  const stateConfig = useMemo(
    () => ({
      results: fetchResults,
      lockSyncResults: exampleLockSyncResults,
      ...nestedFields(args.all),
      options: buildSyncOptions({
        mode: 'fetch',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      }),
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
      command={buildSyncCommand({
        mode: 'fetch',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      })}
      {...(args.interactive === true
        ? {
            timeline: createCommandTimeline({ mode: 'fetch', finalState: stateConfig }),
          }
        : {})}
    />
  )
}

export const WithLockSync: Story = {
  render: WithLockSyncRender,
}

/** Fetch with lock input sync results (including flake.nix/devenv.yaml source file updates) */
const WithLockInputSyncRender = (args: StoryArgs) => {
  const stateConfig = useMemo(
    () => ({
      results: fetchResults,
      lockSyncResults: fetchLockInputSyncResults,
      ...nestedFields(args.all),
      options: buildSyncOptions({
        mode: 'fetch',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      }),
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
      command={buildSyncCommand({
        mode: 'fetch',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      })}
      {...(args.interactive === true
        ? {
            timeline: createCommandTimeline({ mode: 'fetch', finalState: stateConfig }),
          }
        : {})}
    />
  )
}

export const WithLockInputSync: Story = {
  render: WithLockInputSyncRender,
}

/** Fetch with full nix lock sync including source file (flake.nix, devenv.yaml) updates */
const WithSourceFileSyncRender = (args: StoryArgs) => {
  const stateConfig = useMemo(
    () => ({
      results: fetchResults,
      lockSyncResults: fetchFullNixSync,
      ...nestedFields(args.all),
      options: buildSyncOptions({
        mode: 'fetch',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      }),
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
      command={buildSyncCommand({
        mode: 'fetch',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      })}
      {...(args.interactive === true
        ? {
            timeline: createCommandTimeline({ mode: 'fetch', finalState: stateConfig }),
          }
        : {})}
    />
  )
}

export const WithSourceFileSync: Story = {
  render: WithSourceFileSyncRender,
}

/** Fetch with ref propagation (branch changes across members) */
const WithRefSyncRender = (args: StoryArgs) => {
  const stateConfig = useMemo(
    () => ({
      results: fetchResults,
      lockSyncResults: exampleRefSyncResults,
      ...nestedFields(args.all),
      options: buildSyncOptions({
        mode: 'fetch',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      }),
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
      command={buildSyncCommand({
        mode: 'fetch',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      })}
      {...(args.interactive === true
        ? {
            timeline: createCommandTimeline({ mode: 'fetch', finalState: stateConfig }),
          }
        : {})}
    />
  )
}

export const WithRefSync: Story = {
  render: WithRefSyncRender,
}

/** Fetch with shared lock source propagation (e.g. devenv version) */
const WithSharedSourceSyncRender = (args: StoryArgs) => {
  const stateConfig = useMemo(
    () => ({
      results: fetchResults,
      lockSyncResults: [],
      sharedSourceUpdates: exampleSharedSourceSync,
      ...nestedFields(args.all),
      options: buildSyncOptions({
        mode: 'fetch',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      }),
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
      command={buildSyncCommand({
        mode: 'fetch',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      })}
      {...(args.interactive === true
        ? {
            timeline: createCommandTimeline({ mode: 'fetch', finalState: stateConfig }),
          }
        : {})}
    />
  )
}

export const WithSharedSourceSync: Story = {
  render: WithSharedSourceSyncRender,
}

/** Fetch with all three update types: rev sync, ref sync, and shared source sync */
const WithMixedSyncRender = (args: StoryArgs) => {
  const stateConfig = useMemo(
    () => ({
      results: fetchResults,
      lockSyncResults: exampleMixedSyncResults,
      sharedSourceUpdates: exampleMixedSharedSourceSync,
      ...nestedFields(args.all),
      options: buildSyncOptions({
        mode: 'fetch',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      }),
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
      command={buildSyncCommand({
        mode: 'fetch',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      })}
      {...(args.interactive === true
        ? {
            timeline: createCommandTimeline({ mode: 'fetch', finalState: stateConfig }),
          }
        : {})}
    />
  )
}

export const WithMixedSync: Story = {
  render: WithMixedSyncRender,
}
