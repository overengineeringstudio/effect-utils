/**
 * Stories for `mr lock` — records current workspace state into megarepo.lock.
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
}

export default {
  component: SyncView,
  title: 'CLI/Lock/Sync',
  parameters: { layout: 'fullscreen' },
  args: {
    ...defaultStoryArgs,
    dryRun: false,
    verbose: false,
  },
  argTypes: {
    ...commonArgTypes,
    dryRun: {
      description: '--dry-run: show what would be recorded without writing megarepo.lock',
      control: { type: 'boolean' },
    },
    verbose: {
      description: '--verbose: show detailed lock sync information',
      control: { type: 'boolean' },
    },
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

/** All members recorded into megarepo.lock */
export const AllRecorded: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: fixtures.lockSyncAllRecorded,
        options: {
          mode: 'lock' as const,
          dryRun: args.dryRun,
          all: false,
          verbose: args.verbose,
        },
      }),
      [args.dryRun, args.verbose],
    )
    return (
      <TuiStoryPreview
        View={SyncView}
        app={SyncApp}
        initialState={fixtures.createLockState({
          mode: 'lock',
          overrides: args.interactive === true ? { _tag: 'Success', results: [] } : stateConfig,
        })}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive === true
          ? {
              timeline: fixtures.createLockTimeline({ mode: 'lock', finalState: stateConfig }),
            }
          : {})}
      />
    )
  },
}

/** Some members skipped (dirty worktree, pinned) */
export const WithSkipped: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: fixtures.lockSyncWithSkipped,
        options: {
          mode: 'lock' as const,
          dryRun: args.dryRun,
          all: false,
          verbose: args.verbose,
        },
      }),
      [args.dryRun, args.verbose],
    )
    return (
      <TuiStoryPreview
        View={SyncView}
        app={SyncApp}
        initialState={fixtures.createLockState({
          mode: 'lock',
          overrides: args.interactive === true ? { _tag: 'Success', results: [] } : stateConfig,
        })}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive === true
          ? {
              timeline: fixtures.createLockTimeline({ mode: 'lock', finalState: stateConfig }),
            }
          : {})}
      />
    )
  },
}

/** Dry run — preview what would be recorded */
export const DryRun: Story = {
  args: { dryRun: true },
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: fixtures.lockSyncAllRecorded,
        options: { mode: 'lock' as const, dryRun: true, all: false, verbose: args.verbose },
      }),
      [args.verbose],
    )
    return (
      <TuiStoryPreview
        View={SyncView}
        app={SyncApp}
        initialState={fixtures.createLockState({
          mode: 'lock',
          overrides: args.interactive === true ? { _tag: 'Success', results: [] } : stateConfig,
        })}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive === true
          ? {
              timeline: fixtures.createLockTimeline({ mode: 'lock', finalState: stateConfig }),
            }
          : {})}
      />
    )
  },
}
