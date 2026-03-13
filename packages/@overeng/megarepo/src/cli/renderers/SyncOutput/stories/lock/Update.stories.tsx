/**
 * Stories for `mr fetch` — fetches configured refs, updates workspace, writes megarepo.lock.
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
import * as fixtures from './_fixtures.ts'

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
  dryRun: boolean
  verbose: boolean
  all: boolean
}

export default {
  component: SyncView,
  title: 'CLI/Lock/Update',
  parameters: { layout: 'fullscreen' },
  args: {
    ...defaultStoryArgs,
    dryRun: false,
    verbose: false,
    all: false,
  },
  argTypes: {
    ...commonArgTypes,
    dryRun: {
      description: '--dry-run: show what would be fetched/updated without making changes',
      control: { type: 'boolean' },
    },
    verbose: {
      description: '--verbose: show detailed lock input updates per member',
      control: { type: 'boolean' },
    },
    all: {
      description: '--all: recursively update nested megarepos',
      control: { type: 'boolean' },
    },
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

/** Members fetched and updated from configured refs */
export const Updated: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: fixtures.lockUpdateResults,
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
        initialState={fixtures.createLockState({
          mode: 'fetch',
          overrides: args.interactive === true ? { _tag: 'Success', results: [] } : stateConfig,
        })}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive === true
          ? {
              timeline: fixtures.createLockTimeline({
                mode: 'fetch',
                finalState: stateConfig,
              }),
            }
          : {})}
      />
    )
  },
}

/** --create-branches: new branches created during update */
export const WithNewBranches: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: fixtures.lockUpdateWithNewBranches,
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
        initialState={fixtures.createLockState({
          mode: 'fetch',
          overrides: args.interactive === true ? { _tag: 'Success', results: [] } : stateConfig,
        })}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive === true
          ? {
              timeline: fixtures.createLockTimeline({
                mode: 'fetch',
                finalState: stateConfig,
              }),
            }
          : {})}
      />
    )
  },
}

/** Errors during fetch (network timeout, auth failure) */
export const WithErrors: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        _tag: 'Error' as const,
        results: fixtures.lockUpdateWithErrors,
        options: {
          mode: 'fetch' as const,
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
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
      [args.dryRun, args.all, args.verbose],
    )
    return (
      <TuiStoryPreview
        View={SyncView}
        app={SyncApp}
        initialState={fixtures.createLockState({
          mode: 'fetch',
          overrides: args.interactive === true ? { _tag: 'Success', results: [] } : stateConfig,
        })}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive === true
          ? {
              timeline: fixtures.createLockTimeline({
                mode: 'fetch',
                finalState: stateConfig,
              }),
            }
          : {})}
      />
    )
  },
}

/** Update with lock input sync results (flake.lock/devenv.lock) */
export const WithLockInputSync: Story = {
  args: { verbose: true },
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: fixtures.lockUpdateResults,
        lockSyncResults: fixtures.lockUpdateLockSyncResults,
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
        initialState={fixtures.createLockState({
          mode: 'fetch',
          overrides: args.interactive === true ? { _tag: 'Success', results: [] } : stateConfig,
        })}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive === true
          ? {
              timeline: fixtures.createLockTimeline({
                mode: 'fetch',
                finalState: stateConfig,
              }),
            }
          : {})}
      />
    )
  },
}

/** Update with full nix lock sync including source file (flake.nix, devenv.yaml) updates */
export const WithSourceFileSync: Story = {
  args: { verbose: true },
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: fixtures.lockUpdateResults,
        lockSyncResults: fixtures.lockUpdateFullNixSync,
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
        initialState={fixtures.createLockState({
          mode: 'fetch',
          overrides: args.interactive === true ? { _tag: 'Success', results: [] } : stateConfig,
        })}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive === true
          ? {
              timeline: fixtures.createLockTimeline({
                mode: 'fetch',
                finalState: stateConfig,
              }),
            }
          : {})}
      />
    )
  },
}

/** Dry run — preview what would be fetched and updated */
export const DryRun: Story = {
  args: { dryRun: true },
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: fixtures.lockUpdateResults,
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
        initialState={fixtures.createLockState({
          mode: 'fetch',
          overrides: args.interactive === true ? { _tag: 'Success', results: [] } : stateConfig,
        })}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive === true
          ? {
              timeline: fixtures.createLockTimeline({
                mode: 'fetch',
                finalState: stateConfig,
              }),
            }
          : {})}
      />
    )
  },
}
