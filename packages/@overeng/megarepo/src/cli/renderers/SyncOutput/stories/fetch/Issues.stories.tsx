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
import { flagArgTypes } from '../../../_story-constants.ts'
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
        options: {
          mode: 'fetch' as const,
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
          force: args.force,
        },
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
        command={`mr fetch${args.dryRun === true ? ' --dry-run' : ''}${args.all === true ? ' --all' : ''}${args.verbose === true ? ' --verbose' : ''}${args.force === true ? ' --force' : ''}`}
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
        options: {
          mode: 'fetch' as const,
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
          force: args.force,
        },
        results: [
          { name: 'core-lib', status: 'error' as const, message: 'network timeout' },
          { name: 'dev-tools', status: 'error' as const, message: 'authentication failed' },
          { name: 'app-platform', status: 'error' as const, message: 'repository not found' },
          { name: 'private-repo', status: 'error' as const, message: 'permission denied' },
        ],
        members: ['core-lib', 'dev-tools', 'app-platform', 'private-repo'],
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
        command={`mr fetch${args.dryRun === true ? ' --dry-run' : ''}${args.all === true ? ' --all' : ''}${args.verbose === true ? ' --verbose' : ''}${args.force === true ? ' --force' : ''}`}
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
        options: {
          mode: 'fetch' as const,
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
          force: args.force,
        },
        results: [
          { name: 'core-lib', status: 'synced' as const, ref: 'main' },
          { name: 'dirty-repo', status: 'skipped' as const, message: 'dirty worktree' },
          { name: 'pinned-repo', status: 'skipped' as const, message: 'pinned' },
          { name: 'private-repo', status: 'skipped' as const, message: 'authentication required' },
        ] satisfies MemberSyncResult[],
        members: ['core-lib', 'dirty-repo', 'pinned-repo', 'private-repo'],
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
        command={`mr fetch${args.dryRun === true ? ' --dry-run' : ''}${args.all === true ? ' --all' : ''}${args.verbose === true ? ' --verbose' : ''}${args.force === true ? ' --force' : ''}`}
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
        options: {
          mode: 'fetch' as const,
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
          force: args.force,
        },
        results: [
          { name: 'core-lib', status: 'already_synced' as const },
          { name: 'dirty-repo', status: 'skipped' as const, message: '5 uncommitted changes' },
          { name: 'pinned-repo', status: 'skipped' as const, message: 'pinned to v1.0.0' },
          { name: 'auth-repo', status: 'skipped' as const, message: 'authentication required' },
          { name: 'missing-ref', status: 'skipped' as const, message: 'ref feature/x not found' },
        ] satisfies MemberSyncResult[],
        members: ['core-lib', 'dirty-repo', 'pinned-repo', 'auth-repo', 'missing-ref'],
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
        command={`mr fetch${args.dryRun === true ? ' --dry-run' : ''}${args.all === true ? ' --all' : ''}${args.verbose === true ? ' --verbose' : ''}${args.force === true ? ' --force' : ''}`}
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
        options: {
          mode: 'fetch' as const,
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
          force: args.force,
        },
        results: [
          { name: 'core-lib', status: 'synced' as const, ref: 'main' },
          {
            name: 'dev-tools',
            status: 'skipped' as const,
            refMismatch: {
              expectedRef: 'main',
              actualRef: 'feature-branch',
              isDetached: false,
            },
          },
          {
            name: 'app-platform',
            status: 'skipped' as const,
            refMismatch: {
              expectedRef: 'main',
              actualRef: 'abc1234',
              isDetached: true,
            },
          },
          { name: 'studio-org', status: 'synced' as const, ref: 'develop' },
        ] satisfies MemberSyncResult[],
        members: ['core-lib', 'dev-tools', 'app-platform', 'studio-org'],
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
        command={`mr fetch${args.dryRun === true ? ' --dry-run' : ''}${args.all === true ? ' --all' : ''}${args.verbose === true ? ' --verbose' : ''}${args.force === true ? ' --force' : ''}`}
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
        options: {
          mode: 'fetch' as const,
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
          force: args.force,
        },
        _tag: 'Interrupted' as const,
        members: ['core-lib', 'dev-tools', 'app-platform', 'dotfiles'],
        results: [
          { name: 'core-lib', status: 'synced' as const, ref: 'main' },
          { name: 'dev-tools', status: 'cloned' as const, ref: 'main' },
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
        command={`mr fetch${args.dryRun === true ? ' --dry-run' : ''}${args.all === true ? ' --all' : ''}${args.verbose === true ? ' --verbose' : ''}${args.force === true ? ' --force' : ''}`}
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
        options: {
          mode: 'fetch' as const,
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
          force: args.force,
        },
        syncErrorCount: 2,
        syncErrors: [
          {
            megarepoRoot: '/Users/dev/.megarepo/github.com/alice/dev-workspace/refs/heads/main/',
            memberName: 'dev-tools',
            message: 'network timeout during fetch',
          },
          {
            megarepoRoot: '/Users/dev/.megarepo/github.com/alice/dev-workspace/refs/heads/main/',
            memberName: 'private-repo',
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
