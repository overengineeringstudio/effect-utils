/**
 * Issue/error/skipped stories for `mr fetch`.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useMemo } from 'react'

import {
  ALL_OUTPUT_TABS,
  commonArgTypes,
  defaultStoryArgs,
  TuiStoryPreview,
} from '@overeng/tui-react/storybook'

import type { MemberSyncResult } from '../../../../../lib/sync/schema.ts'
import {
  buildSyncCommand,
  buildSyncOptions,
  flagArgTypes,
  MEMBERS,
  WORKSPACE,
} from '../../../_story-constants.ts'
import { SyncApp } from '../../mod.ts'
import { SyncView } from '../../view.tsx'
import {
  createBaseState,
  createCommandState,
  createCommandTimeline,
  createTimeline,
  exampleSyncResultsWithErrors,
} from '../_fixtures.ts'
import { fetchWithErrors } from './_fixtures.ts'

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
  title: 'CLI/Fetch/Issues',
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

/** Some members failed with errors */
export const WithErrors: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        options: buildSyncOptions({
          mode: 'fetch',
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
          force: args.force,
        }),
        results: exampleSyncResultsWithErrors,
        members: exampleSyncResultsWithErrors.map((r) => r.name),
      }),
      [args.dryRun, args.all, args.verbose, args.force],
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
  },
}

/** All members failed */
export const AllErrors: Story = {
  render: (args) => {
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
          { name: MEMBERS.coreLib, status: 'error' as const, message: 'network timeout' },
          { name: MEMBERS.devTools, status: 'error' as const, message: 'authentication failed' },
          { name: MEMBERS.appPlatform, status: 'error' as const, message: 'repository not found' },
          { name: MEMBERS.studioOrg, status: 'error' as const, message: 'permission denied' },
        ],
        members: [MEMBERS.coreLib, MEMBERS.devTools, MEMBERS.appPlatform, MEMBERS.studioOrg],
      }),
      [args.dryRun, args.all, args.verbose, args.force],
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
  },
}

/** Members skipped for various reasons */
export const SkippedMembers: Story = {
  render: (args) => {
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
          { name: MEMBERS.devTools, status: 'skipped' as const, message: 'dirty worktree' },
          { name: MEMBERS.appPlatform, status: 'skipped' as const, message: 'pinned' },
          {
            name: MEMBERS.studioOrg,
            status: 'skipped' as const,
            message: 'authentication required',
          },
        ] satisfies MemberSyncResult[],
        members: [MEMBERS.coreLib, MEMBERS.devTools, MEMBERS.appPlatform, MEMBERS.studioOrg],
      }),
      [args.dryRun, args.all, args.verbose, args.force],
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
  },
}

/** Mixed skipped reasons */
export const MixedSkipped: Story = {
  render: (args) => {
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
          { name: MEMBERS.coreLib, status: 'already_synced' as const },
          { name: MEMBERS.devTools, status: 'skipped' as const, message: '5 uncommitted changes' },
          { name: MEMBERS.appPlatform, status: 'skipped' as const, message: 'pinned to v1.0.0' },
          {
            name: MEMBERS.dotfiles,
            status: 'skipped' as const,
            message: 'authentication required',
          },
          {
            name: MEMBERS.homepage,
            status: 'skipped' as const,
            message: 'ref feature/x not found',
          },
        ] satisfies MemberSyncResult[],
        members: [
          MEMBERS.coreLib,
          MEMBERS.devTools,
          MEMBERS.appPlatform,
          MEMBERS.dotfiles,
          MEMBERS.homepage,
        ],
      }),
      [args.dryRun, args.all, args.verbose, args.force],
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
  },
}

/** Ref mismatch detection */
export const RefMismatchDetected: Story = {
  args: { height: 500 },
  render: (args) => {
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
          {
            name: MEMBERS.devTools,
            status: 'skipped' as const,
            refMismatch: {
              expectedRef: 'main',
              actualRef: 'feature-branch',
              isDetached: false,
            },
          },
          {
            name: MEMBERS.appPlatform,
            status: 'skipped' as const,
            refMismatch: {
              expectedRef: 'main',
              actualRef: 'abc1234',
              isDetached: true,
            },
          },
          { name: MEMBERS.studioOrg, status: 'synced' as const, ref: 'develop' },
        ] satisfies MemberSyncResult[],
        members: [MEMBERS.coreLib, MEMBERS.devTools, MEMBERS.appPlatform, MEMBERS.studioOrg],
      }),
      [args.dryRun, args.all, args.verbose, args.force],
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
  },
}

/** Sync interrupted */
export const Interrupted: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        options: buildSyncOptions({
          mode: 'fetch',
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
          force: args.force,
        }),
        _tag: 'Interrupted' as const,
        members: [MEMBERS.coreLib, MEMBERS.devTools, MEMBERS.appPlatform, MEMBERS.dotfiles],
        results: [
          { name: MEMBERS.coreLib, status: 'synced' as const, ref: 'main' },
          { name: MEMBERS.devTools, status: 'cloned' as const, ref: 'main' },
        ] satisfies MemberSyncResult[],
      }),
      [args.dryRun, args.all, args.verbose, args.force],
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
  },
}

/** Members excluded via --only or --skip flags */
export const WithSkippedMembers: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        options: buildSyncOptions({
          mode: 'fetch',
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
          force: args.force,
          skippedMembers: [MEMBERS.studioOrg, MEMBERS.homepage],
        }),
        results: [
          { name: MEMBERS.coreLib, status: 'synced' as const, ref: 'main' },
          { name: MEMBERS.devTools, status: 'synced' as const, ref: 'main' },
          { name: MEMBERS.appPlatform, status: 'already_synced' as const },
          { name: MEMBERS.dotfiles, status: 'synced' as const, ref: 'main' },
        ] satisfies MemberSyncResult[],
        members: [MEMBERS.coreLib, MEMBERS.devTools, MEMBERS.appPlatform, MEMBERS.dotfiles],
      }),
      [args.dryRun, args.all, args.verbose, args.force],
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
  },
}

/** Fetch errors with detailed sync error messages */
export const FetchErrors: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        _tag: 'Error' as const,
        results: fetchWithErrors,
        options: buildSyncOptions({
          mode: 'fetch',
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
          force: args.force,
        }),
        syncErrorCount: 2,
        syncErrors: [
          {
            megarepoRoot: WORKSPACE.root,
            memberName: MEMBERS.devTools,
            message: 'network timeout during fetch',
          },
          {
            megarepoRoot: WORKSPACE.root,
            memberName: MEMBERS.studioOrg,
            message: 'authentication failed',
          },
        ],
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
  },
}
