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

import {
  buildSyncCommand,
  buildSyncOptions,
  flagArgTypes,
  MEMBERS,
  MEGAREPO_MEMBERS,
  STORE_BASE,
} from '../../../_story-constants.ts'
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
  force: boolean
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

/** Mixed sync results — cloned, synced, updated, skipped */
const MixedResultsRender = (args: StoryArgs) => {
  const stateConfig = useMemo(
    () => ({
      options: buildSyncOptions({
        mode: 'fetch',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      }),
      results: exampleSyncResults,
      members: exampleSyncResults.map((r) => r.name),
      nestedMegarepos: [MEMBERS.devTools],
      generatedFiles: ['flake.nix', '.envrc'],
    }),
    [args.dryRun, args.all, args.verbose, args.force],
  )
  return (
    <TuiStoryPreview
      View={SyncView}
      app={SyncApp}
      initialState={createBaseState(args.interactive === true ? { _tag: 'Success' } : stateConfig)}
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
      {...(args.interactive === true ? { timeline: createTimeline(stateConfig) } : {})}
    />
  )
}

export const MixedResults: Story = {
  render: MixedResultsRender,
}

/** All members already up to date */
const AllUpToDateRender = (args: StoryArgs) => {
  const stateConfig = useMemo(
    () => ({
      options: buildSyncOptions({
        mode: 'fetch',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      }),
      workspace: {
        name: 'dev-workspace-blue',
        root: `${STORE_BASE}/github.com/alice/dev-workspace-blue/refs/heads/main/`,
      },
      results: exampleAllSynced,
      members: exampleAllSynced.map((r) => r.name),
    }),
    [args.dryRun, args.all, args.verbose, args.force],
  )
  return (
    <TuiStoryPreview
      View={SyncView}
      app={SyncApp}
      initialState={createBaseState(args.interactive === true ? { _tag: 'Success' } : stateConfig)}
      height={args.height}
      autoRun={args.interactive}
      playbackSpeed={args.playbackSpeed}
      tabs={ALL_OUTPUT_TABS}
      cwd="~/dev-workspace-blue"
      command={buildSyncCommand({
        mode: 'fetch',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      })}
      {...(args.interactive === true ? { timeline: createTimeline(stateConfig) } : {})}
    />
  )
}

export const AllUpToDate: Story = {
  render: AllUpToDateRender,
}

/** First fetch — all members cloned */
const InitialFetchRender = (args: StoryArgs) => {
  const stateConfig = useMemo(
    () => ({
      options: buildSyncOptions({
        mode: 'fetch',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      }),
      workspace: {
        name: 'new-workspace',
        root: `${STORE_BASE}/github.com/alice/new-workspace/refs/heads/main/`,
      },
      results: [
        { name: MEMBERS.coreLib, status: 'cloned' as const, ref: 'main' },
        { name: MEMBERS.devTools, status: 'cloned' as const, ref: 'main' },
        { name: MEMBERS.appPlatform, status: 'cloned' as const, ref: 'dev' },
        { name: MEMBERS.dotfiles, status: 'cloned' as const, ref: 'main' },
      ],
      members: [MEMBERS.coreLib, MEMBERS.devTools, MEMBERS.appPlatform, MEMBERS.dotfiles],
      generatedFiles: ['flake.nix'],
    }),
    [args.dryRun, args.all, args.verbose, args.force],
  )
  return (
    <TuiStoryPreview
      View={SyncView}
      app={SyncApp}
      initialState={createBaseState(args.interactive === true ? { _tag: 'Success' } : stateConfig)}
      height={args.height}
      autoRun={args.interactive}
      playbackSpeed={args.playbackSpeed}
      tabs={ALL_OUTPUT_TABS}
      cwd="~/new-workspace"
      command={buildSyncCommand({
        mode: 'fetch',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      })}
      {...(args.interactive === true ? { timeline: createTimeline(stateConfig) } : {})}
    />
  )
}

export const InitialFetch: Story = {
  render: InitialFetchRender,
}

/** Members fetched and updated */
const UpdatedRender = (args: StoryArgs) => {
  const stateConfig = useMemo(
    () => ({
      results: fetchResults,
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

export const Updated: Story = {
  render: UpdatedRender,
}

/** New branches created during fetch */
const WithNewBranchesRender = (args: StoryArgs) => {
  const stateConfig = useMemo(
    () => ({
      results: fetchWithNewBranches,
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

export const WithNewBranches: Story = {
  render: WithNewBranchesRender,
}

/** Members removed from config */
const RemovedMembersRender = (args: StoryArgs) => {
  const stateConfig = useMemo(
    () => ({
      options: buildSyncOptions({
        mode: 'fetch',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      }),
      results: [
        { name: MEMBERS.coreLib, status: 'synced' as const, ref: 'main' },
        { name: 'old-repo', status: 'removed' as const, message: '/store/old-repo-abc123' },
        { name: 'deprecated', status: 'removed' as const, message: '/store/deprecated-def456' },
      ],
      members: [MEMBERS.coreLib, 'old-repo', 'deprecated'],
    }),
    [args.dryRun, args.all, args.verbose, args.force],
  )
  return (
    <TuiStoryPreview
      View={SyncView}
      app={SyncApp}
      initialState={createBaseState(args.interactive === true ? { _tag: 'Success' } : stateConfig)}
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
      {...(args.interactive === true ? { timeline: createTimeline(stateConfig) } : {})}
    />
  )
}

export const RemovedMembers: Story = {
  render: RemovedMembersRender,
}

/** With generated files */
const WithGeneratorsRender = (args: StoryArgs) => {
  const stateConfig = useMemo(
    () => ({
      options: buildSyncOptions({
        mode: 'fetch',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      }),
      results: [
        { name: MEMBERS.coreLib, status: 'synced' as const, ref: 'main' },
        { name: MEMBERS.devTools, status: 'synced' as const, ref: 'main' },
        { name: MEMBERS.appPlatform, status: 'cloned' as const, ref: 'main' },
        { name: MEMBERS.dotfiles, status: 'already_synced' as const },
      ],
      members: [MEMBERS.coreLib, MEMBERS.devTools, MEMBERS.appPlatform, MEMBERS.dotfiles],
      generatedFiles: ['flake.nix', 'flake.lock', '.vscode/megarepo.code-workspace'],
    }),
    [args.dryRun, args.all, args.verbose, args.force],
  )
  return (
    <TuiStoryPreview
      View={SyncView}
      app={SyncApp}
      initialState={createBaseState(args.interactive === true ? { _tag: 'Success' } : stateConfig)}
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
      {...(args.interactive === true ? { timeline: createTimeline(stateConfig) } : {})}
    />
  )
}

export const WithGenerators: Story = {
  render: WithGeneratorsRender,
}

/** Single member workspace */
const SingleMemberRender = (args: StoryArgs) => {
  const stateConfig = useMemo(
    () => ({
      options: buildSyncOptions({
        mode: 'fetch',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      }),
      results: [{ name: MEMBERS.coreLib, status: 'synced' as const, ref: 'main' }],
      members: [MEMBERS.coreLib],
    }),
    [args.dryRun, args.all, args.verbose, args.force],
  )
  return (
    <TuiStoryPreview
      View={SyncView}
      app={SyncApp}
      initialState={createBaseState(args.interactive === true ? { _tag: 'Success' } : stateConfig)}
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
      {...(args.interactive === true ? { timeline: createTimeline(stateConfig) } : {})}
    />
  )
}

export const SingleMember: Story = {
  render: SingleMemberRender,
}

/** Large workspace with many members */
const ManyMembersRender = (args: StoryArgs) => {
  const stateConfig = useMemo(() => {
    const results = Array.from({ length: 10 }, (_, i) => ({
      name: `repo-${String(i + 1).padStart(2, '0')}`,
      status: 'already_synced' as const,
    }))
    return {
      options: buildSyncOptions({
        mode: 'fetch',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      }),
      workspace: {
        name: 'large-workspace',
        root: `${STORE_BASE}/github.com/alice/large-workspace/refs/heads/main/`,
      },
      results,
      members: results.map((r) => r.name),
    }
  }, [args.dryRun, args.all, args.verbose, args.force])
  return (
    <TuiStoryPreview
      View={SyncView}
      app={SyncApp}
      initialState={createBaseState(args.interactive === true ? { _tag: 'Success' } : stateConfig)}
      height={args.height}
      autoRun={args.interactive}
      playbackSpeed={args.playbackSpeed}
      tabs={ALL_OUTPUT_TABS}
      cwd="~/large-workspace"
      command={buildSyncCommand({
        mode: 'fetch',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      })}
      {...(args.interactive === true ? { timeline: createTimeline(stateConfig) } : {})}
    />
  )
}

export const ManyMembers: Story = {
  render: ManyMembersRender,
}

/** Nested megarepos hint */
const NestedMegareposRender = (args: StoryArgs) => {
  const stateConfig = useMemo(
    () => ({
      options: buildSyncOptions({
        mode: 'fetch',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      }),
      results: [
        { name: MEMBERS.coreLib, status: 'synced' as const, ref: 'main' },
        { name: MEMBERS.devTools, status: 'synced' as const, ref: 'main' },
        { name: MEMBERS.appPlatform, status: 'synced' as const, ref: 'main' },
      ],
      members: [MEMBERS.coreLib, MEMBERS.devTools, MEMBERS.appPlatform],
      nestedMegarepos: [...MEGAREPO_MEMBERS],
    }),
    [args.dryRun, args.all, args.verbose, args.force],
  )
  return (
    <TuiStoryPreview
      View={SyncView}
      app={SyncApp}
      initialState={createBaseState(args.interactive === true ? { _tag: 'Success' } : stateConfig)}
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
      {...(args.interactive === true ? { timeline: createTimeline(stateConfig) } : {})}
    />
  )
}

export const NestedMegarepos: Story = {
  render: NestedMegareposRender,
}
