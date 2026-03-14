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
}

export default {
  component: SyncView,
  title: 'CLI/Fetch/Issues',
  parameters: { layout: 'fullscreen' },
  args: {
    ...defaultStoryArgs,
    dryRun: false,
    all: false,
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
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

/** Some members failed with errors */
export const WithErrors: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        options: { mode: 'fetch' as const, dryRun: args.dryRun, all: args.all },
        results: exampleSyncResultsWithErrors,
        members: exampleSyncResultsWithErrors.map((r) => r.name),
      }),
      [args.dryRun, args.all],
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
        command={`mr fetch${args.dryRun ? ' --dry-run' : ''}${args.all ? ' --all' : ''}`}
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
        options: { mode: 'fetch' as const, dryRun: args.dryRun, all: args.all },
        results: [
          { name: 'effect', status: 'error' as const, message: 'network timeout' },
          { name: 'effect-utils', status: 'error' as const, message: 'authentication failed' },
          { name: 'livestore', status: 'error' as const, message: 'repository not found' },
          { name: 'private-repo', status: 'error' as const, message: 'permission denied' },
        ],
        members: ['effect', 'effect-utils', 'livestore', 'private-repo'],
      }),
      [args.dryRun, args.all],
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
        command={`mr fetch${args.dryRun ? ' --dry-run' : ''}${args.all ? ' --all' : ''}`}
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
        options: { mode: 'fetch' as const, dryRun: args.dryRun, all: args.all },
        results: [
          { name: 'effect', status: 'synced' as const, ref: 'main' },
          { name: 'dirty-repo', status: 'skipped' as const, message: 'dirty worktree' },
          { name: 'pinned-repo', status: 'skipped' as const, message: 'pinned' },
          { name: 'private-repo', status: 'skipped' as const, message: 'authentication required' },
        ] satisfies MemberSyncResult[],
        members: ['effect', 'dirty-repo', 'pinned-repo', 'private-repo'],
      }),
      [args.dryRun, args.all],
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
        command={`mr fetch${args.dryRun ? ' --dry-run' : ''}${args.all ? ' --all' : ''}`}
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
        options: { mode: 'fetch' as const, dryRun: args.dryRun, all: args.all },
        results: [
          { name: 'effect', status: 'already_synced' as const },
          { name: 'dirty-repo', status: 'skipped' as const, message: '5 uncommitted changes' },
          { name: 'pinned-repo', status: 'skipped' as const, message: 'pinned to v1.0.0' },
          { name: 'auth-repo', status: 'skipped' as const, message: 'authentication required' },
          { name: 'missing-ref', status: 'skipped' as const, message: 'ref feature/x not found' },
        ] satisfies MemberSyncResult[],
        members: ['effect', 'dirty-repo', 'pinned-repo', 'auth-repo', 'missing-ref'],
      }),
      [args.dryRun, args.all],
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
        command={`mr fetch${args.dryRun ? ' --dry-run' : ''}${args.all ? ' --all' : ''}`}
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
        options: { mode: 'fetch' as const, dryRun: args.dryRun, all: args.all },
        results: [
          { name: 'effect', status: 'synced' as const, ref: 'main' },
          {
            name: 'effect-utils',
            status: 'skipped' as const,
            refMismatch: {
              expectedRef: 'main',
              actualRef: 'feature-branch',
              isDetached: false,
            },
          },
          {
            name: 'livestore',
            status: 'skipped' as const,
            refMismatch: {
              expectedRef: 'main',
              actualRef: 'abc1234',
              isDetached: true,
            },
          },
          { name: 'other-repo', status: 'synced' as const, ref: 'develop' },
        ] satisfies MemberSyncResult[],
        members: ['effect', 'effect-utils', 'livestore', 'other-repo'],
      }),
      [args.dryRun, args.all],
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
        command={`mr fetch${args.dryRun ? ' --dry-run' : ''}${args.all ? ' --all' : ''}`}
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
        options: { mode: 'fetch' as const, dryRun: args.dryRun, all: args.all },
        _tag: 'Interrupted' as const,
        members: ['effect', 'effect-utils', 'livestore', 'dotfiles'],
        results: [
          { name: 'effect', status: 'synced' as const, ref: 'main' },
          { name: 'effect-utils', status: 'cloned' as const, ref: 'main' },
        ] satisfies MemberSyncResult[],
      }),
      [args.dryRun, args.all],
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
        command={`mr fetch${args.dryRun ? ' --dry-run' : ''}${args.all ? ' --all' : ''}`}
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
          verbose: false,
        },
        syncErrorCount: 2,
        syncErrors: [
          {
            megarepoRoot: '/Users/dev/workspace',
            memberName: 'effect-utils',
            message: 'network timeout during fetch',
          },
          {
            megarepoRoot: '/Users/dev/workspace',
            memberName: 'private-repo',
            message: 'authentication failed',
          },
        ],
      }),
      [args.dryRun, args.all],
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
        command={`mr fetch${args.dryRun ? ' --dry-run' : ''}${args.all ? ' --all' : ''}`}
        {...(args.interactive === true
          ? {
              timeline: createCommandTimeline({ mode: 'fetch', finalState: stateConfig }),
            }
          : {})}
      />
    )
  },
}
