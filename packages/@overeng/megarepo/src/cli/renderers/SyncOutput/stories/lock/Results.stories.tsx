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

import type { MemberSyncResult } from '../../../../../lib/sync/schema.ts'
import {
  buildSyncCommand,
  buildSyncOptions,
  flagArgTypes,
  MEGAREPO_MEMBERS,
  WORKSPACE,
} from '../../../_story-constants.ts'
import { SyncApp } from '../../mod.ts'
import { SyncView } from '../../view.tsx'
import { exampleNestedSyncTrees } from '../_fixtures.ts'
import * as sharedFixtures from '../_fixtures.ts'
import * as fixtures from './_fixtures.ts'

/** Builds syncTree and nestedMegarepos fields based on --all flag */
const nestedFields = ({ all, results }: { all: boolean; results: MemberSyncResult[] }) => ({
  nestedMegarepos: all === true ? [] : [...MEGAREPO_MEMBERS],
  syncTree: {
    root: WORKSPACE.root,
    results,
    nestedMegarepos: all === true ? [] : [...MEGAREPO_MEMBERS],
    nestedResults: all === true ? exampleNestedSyncTrees : [],
  },
})

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
const AllRecordedRender = (args: StoryArgs) => {
  const stateConfig = useMemo(
    () => ({
      results: fixtures.lockAllRecorded,
      options: buildSyncOptions({
        mode: 'lock',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      }),
      ...nestedFields({ all: args.all, results: fixtures.lockAllRecorded }),
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
}

export const AllRecorded: Story = {
  render: AllRecordedRender,
}

/** Members recorded with commit changes */
const WithUpdatesRender = (args: StoryArgs) => {
  const stateConfig = useMemo(
    () => ({
      results: fixtures.lockWithUpdates,
      options: buildSyncOptions({
        mode: 'lock',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      }),
      ...nestedFields({ all: args.all, results: fixtures.lockWithUpdates }),
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
}

export const WithUpdates: Story = {
  render: WithUpdatesRender,
}

/** Some members skipped (dirty worktree, pinned) */
const WithSkippedRender = (args: StoryArgs) => {
  const stateConfig = useMemo(() => {
    const results = sharedFixtures.applyForceFlag({
      results: fixtures.lockWithSkipped,
      force: args.force,
    })
    return {
      results,
      options: buildSyncOptions({
        mode: 'lock',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      }),
      ...nestedFields({ all: args.all, results }),
    }
  }, [args.dryRun, args.verbose, args.all, args.force])
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
}

export const WithSkipped: Story = {
  render: WithSkippedRender,
}

/** Pinned members — toggle force flag to see pinned vs skipped */
const WithPinnedMembersRender = (args: StoryArgs) => {
  const stateConfig = useMemo(() => {
    const results = sharedFixtures.applyForceFlag({
      results: fixtures.lockWithPinned,
      force: args.force,
    })
    return {
      results,
      options: buildSyncOptions({
        mode: 'lock',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      }),
      ...nestedFields({ all: args.all, results }),
    }
  }, [args.dryRun, args.verbose, args.all, args.force])
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
}

export const WithPinnedMembers: Story = {
  args: { force: false },
  render: WithPinnedMembersRender,
}
