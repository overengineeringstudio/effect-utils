/**
 * Stories for `mr lock` — records current member commits into megarepo.lock.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useMemo } from 'react'

import {
  ALL_OUTPUT_TABS,
  commonArgTypes,
  defaultStoryArgs,
  TuiStoryPreview,
} from '@overeng/tui-react/storybook'

import { buildSyncCommand, flagArgTypes } from '../../../_story-constants.ts'
import { SyncApp } from '../../mod.ts'
import { SyncView } from '../../view.tsx'
import * as sharedFixtures from '../_fixtures.ts'
import * as fixtures from './_fixtures.ts'

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
  dryRun: boolean
  verbose: boolean
  all: boolean
  force: boolean
}

export default {
  component: SyncView,
  title: 'CLI/Lock/Results',
  parameters: { layout: 'fullscreen' },
  args: {
    ...defaultStoryArgs,
    dryRun: false,
    verbose: false,
    all: false,
    force: false,
  },
  argTypes: {
    ...commonArgTypes,
    dryRun: flagArgTypes.dryRun,
    verbose: flagArgTypes.verbose,
    all: flagArgTypes.all,
    force: flagArgTypes.force,
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

/** All members recorded into megarepo.lock successfully */
export const AllRecorded: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: fixtures.lockAllRecorded,
        options: {
          mode: 'lock' as const,
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
          force: args.force,
        },
      }),
      [args.dryRun, args.verbose, args.all, args.force],
    )
    return (
      <TuiStoryPreview
        View={SyncView}
        app={SyncApp}
        initialState={sharedFixtures.createCommandState({
          mode: 'lock',
          overrides: args.interactive === true ? { _tag: 'Success', results: [] } : stateConfig,
        })}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        cwd="~/workspace"
        command={buildSyncCommand({
          mode: 'lock',
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
          force: args.force,
        })}
        {...(args.interactive === true
          ? {
              timeline: sharedFixtures.createCommandTimeline({
                mode: 'lock',
                finalState: stateConfig,
              }),
            }
          : {})}
      />
    )
  },
}

/** Members recorded with commit changes */
export const WithUpdates: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: fixtures.lockWithUpdates,
        options: {
          mode: 'lock' as const,
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
          force: args.force,
        },
      }),
      [args.dryRun, args.verbose, args.all, args.force],
    )
    return (
      <TuiStoryPreview
        View={SyncView}
        app={SyncApp}
        initialState={sharedFixtures.createCommandState({
          mode: 'lock',
          overrides: args.interactive === true ? { _tag: 'Success', results: [] } : stateConfig,
        })}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        cwd="~/workspace"
        command={buildSyncCommand({
          mode: 'lock',
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
          force: args.force,
        })}
        {...(args.interactive === true
          ? {
              timeline: sharedFixtures.createCommandTimeline({
                mode: 'lock',
                finalState: stateConfig,
              }),
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
        results: sharedFixtures.applyForceFlag({
          results: fixtures.lockWithSkipped,
          force: args.force,
        }),
        options: {
          mode: 'lock' as const,
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
          force: args.force,
        },
      }),
      [args.dryRun, args.verbose, args.all, args.force],
    )
    return (
      <TuiStoryPreview
        View={SyncView}
        app={SyncApp}
        initialState={sharedFixtures.createCommandState({
          mode: 'lock',
          overrides: args.interactive === true ? { _tag: 'Success', results: [] } : stateConfig,
        })}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        cwd="~/workspace"
        command={buildSyncCommand({
          mode: 'lock',
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
          force: args.force,
        })}
        {...(args.interactive === true
          ? {
              timeline: sharedFixtures.createCommandTimeline({
                mode: 'lock',
                finalState: stateConfig,
              }),
            }
          : {})}
      />
    )
  },
}

/** Pinned members — toggle force flag to see pinned vs skipped */
export const WithPinnedMembers: Story = {
  args: { force: false },
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: sharedFixtures.applyForceFlag({
          results: fixtures.lockWithPinned,
          force: args.force,
        }),
        options: {
          mode: 'lock' as const,
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
          force: args.force,
        },
      }),
      [args.dryRun, args.verbose, args.all, args.force],
    )
    return (
      <TuiStoryPreview
        View={SyncView}
        app={SyncApp}
        initialState={sharedFixtures.createCommandState({
          mode: 'lock',
          overrides: stateConfig,
        })}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        cwd="~/workspace"
        command={buildSyncCommand({
          mode: 'lock',
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
          force: args.force,
        })}
      />
    )
  },
}
