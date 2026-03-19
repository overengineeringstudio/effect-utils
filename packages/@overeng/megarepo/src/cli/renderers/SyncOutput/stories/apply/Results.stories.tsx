/**
 * Stories for `mr apply` — applies exact commits from megarepo.lock for reproducible CI.
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
  CI_WORKSPACE,
  flagArgTypes,
  MEGAREPO_MEMBERS,
  MEMBERS,
  WORKSPACE,
} from '../../../_story-constants.ts'
import { SyncApp } from '../../mod.ts'
import { SyncView } from '../../view.tsx'
import * as sharedFixtures from '../_fixtures.ts'
import { applyForceFlag, exampleLockSyncResults, exampleNestedSyncTrees } from '../_fixtures.ts'
import * as fixtures from './_fixtures.ts'

/** Builds syncTree and nestedMegarepos fields based on --all flag */
const nestedFields = ({
  all,
  root,
  results,
}: {
  all: boolean
  root: string
  results: MemberSyncResult[]
}) => ({
  nestedMegarepos: all === true ? [] : [...MEGAREPO_MEMBERS],
  syncTree: {
    root,
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
  title: 'CLI/Apply/Results',
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

/** All members applied from lockfile (typical CI scenario) */
const FullApplyRender = (args: StoryArgs) => {
  const stateConfig = useMemo(
    () => ({
      results: fixtures.applyResults,
      workspace: CI_WORKSPACE,
      options: buildSyncOptions({
        mode: 'apply',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      }),
      ...nestedFields({ all: args.all, root: CI_WORKSPACE.root, results: fixtures.applyResults }),
    }),
    [args.dryRun, args.verbose, args.all, args.force],
  )
  return (
    <TuiStoryPreview
      View={SyncView}
      app={SyncApp}
      initialState={sharedFixtures.createCommandState({
        mode: 'apply',
        overrides: args.interactive === true ? { _tag: 'Success', results: [] } : stateConfig,
      })}
      height={args.height}
      autoRun={args.interactive}
      playbackSpeed={args.playbackSpeed}
      tabs={ALL_OUTPUT_TABS}
      cwd={CI_WORKSPACE.root}
      command={buildSyncCommand({
        mode: 'apply',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      })}
      {...(args.interactive === true
        ? {
            timeline: sharedFixtures.createCommandTimeline({
              mode: 'apply',
              finalState: stateConfig,
            }),
          }
        : {})}
    />
  )
}

export const FullApply: Story = {
  render: FullApplyRender,
}

/** Some members already at locked commit */
const PartialApplyRender = (args: StoryArgs) => {
  const stateConfig = useMemo(
    () => ({
      results: fixtures.applyPartial,
      options: buildSyncOptions({
        mode: 'apply',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      }),
      ...nestedFields({ all: args.all, root: WORKSPACE.root, results: fixtures.applyPartial }),
    }),
    [args.dryRun, args.verbose, args.all, args.force],
  )
  return (
    <TuiStoryPreview
      View={SyncView}
      app={SyncApp}
      initialState={sharedFixtures.createCommandState({
        mode: 'apply',
        overrides: args.interactive === true ? { _tag: 'Success', results: [] } : stateConfig,
      })}
      height={args.height}
      autoRun={args.interactive}
      playbackSpeed={args.playbackSpeed}
      tabs={ALL_OUTPUT_TABS}
      cwd="~/workspace"
      command={buildSyncCommand({
        mode: 'apply',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      })}
      {...(args.interactive === true
        ? {
            timeline: sharedFixtures.createCommandTimeline({
              mode: 'apply',
              finalState: stateConfig,
            }),
          }
        : {})}
    />
  )
}

export const PartialApply: Story = {
  render: PartialApplyRender,
}

/** Apply failures — stale lockfile, missing commits */
const WithErrorsRender = (args: StoryArgs) => {
  const stateConfig = useMemo(
    () => ({
      _tag: 'Error' as const,
      results: fixtures.applyWithErrors,
      workspace: CI_WORKSPACE,
      options: buildSyncOptions({
        mode: 'apply',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      }),
      ...nestedFields({
        all: args.all,
        root: CI_WORKSPACE.root,
        results: fixtures.applyWithErrors,
      }),
      syncErrorCount: 2,
      syncErrors: [
        {
          megarepoRoot: CI_WORKSPACE.root,
          memberName: MEMBERS.devTools,
          message: `commit ${fixtures.applyWithErrors[1]!.name} not found — run mr fetch`,
        },
        {
          megarepoRoot: CI_WORKSPACE.root,
          memberName: MEMBERS.dotfiles,
          message: 'repository not found',
        },
      ],
    }),
    [args.dryRun, args.verbose, args.all, args.force],
  )
  return (
    <TuiStoryPreview
      View={SyncView}
      app={SyncApp}
      initialState={sharedFixtures.createCommandState({
        mode: 'apply',
        overrides: args.interactive === true ? { _tag: 'Success', results: [] } : stateConfig,
      })}
      height={args.height}
      autoRun={args.interactive}
      playbackSpeed={args.playbackSpeed}
      tabs={ALL_OUTPUT_TABS}
      cwd={CI_WORKSPACE.root}
      command={buildSyncCommand({
        mode: 'apply',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      })}
      {...(args.interactive === true
        ? {
            timeline: sharedFixtures.createCommandTimeline({
              mode: 'apply',
              finalState: stateConfig,
            }),
          }
        : {})}
    />
  )
}

export const WithErrors: Story = {
  render: WithErrorsRender,
}

/** No megarepo.lock found — user must run `mr fetch` first */
const LockRequiredRender = (args: StoryArgs) => {
  const stateConfig = useMemo(
    () => ({
      _tag: 'Error' as const,
      results: [],
      workspace: {
        name: 'dev-workspace',
        root: '/Users/dev/.megarepo/github.com/alice/dev-workspace/refs/heads/main/',
      },
      options: buildSyncOptions({
        mode: 'apply',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      }),
      syncErrorCount: 1,
      syncErrors: [
        {
          megarepoRoot: '/Users/dev/.megarepo/github.com/alice/dev-workspace/refs/heads/main/',
          memberName: '',
          message: 'No megarepo.lock found. Run `mr fetch` to create one.',
        },
      ],
    }),
    [args.dryRun, args.verbose, args.all, args.force],
  )
  return (
    <TuiStoryPreview
      View={SyncView}
      app={SyncApp}
      initialState={sharedFixtures.createCommandState({
        mode: 'apply',
        overrides: stateConfig,
      })}
      height={args.height}
      autoRun={false}
      playbackSpeed={args.playbackSpeed}
      tabs={ALL_OUTPUT_TABS}
      cwd="~/workspace"
      command="mr apply"
    />
  )
}

export const LockRequired: Story = {
  render: LockRequiredRender,
}

/** Apply with lock sync results (lock files updated alongside apply) */
const WithLockSyncRender = (args: StoryArgs) => {
  const stateConfig = useMemo(
    () => ({
      results: fixtures.applyWithLockSync,
      lockSyncResults: exampleLockSyncResults,
      workspace: CI_WORKSPACE,
      options: buildSyncOptions({
        mode: 'apply',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      }),
      ...nestedFields({
        all: args.all,
        root: CI_WORKSPACE.root,
        results: fixtures.applyWithLockSync,
      }),
    }),
    [args.dryRun, args.verbose, args.all, args.force],
  )
  return (
    <TuiStoryPreview
      View={SyncView}
      app={SyncApp}
      initialState={sharedFixtures.createCommandState({
        mode: 'apply',
        overrides: args.interactive === true ? { _tag: 'Success', results: [] } : stateConfig,
      })}
      height={args.height}
      autoRun={args.interactive}
      playbackSpeed={args.playbackSpeed}
      tabs={ALL_OUTPUT_TABS}
      cwd={CI_WORKSPACE.root}
      command={buildSyncCommand({
        mode: 'apply',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      })}
      {...(args.interactive === true
        ? {
            timeline: sharedFixtures.createCommandTimeline({
              mode: 'apply',
              finalState: stateConfig,
            }),
          }
        : {})}
    />
  )
}

export const WithLockSync: Story = {
  render: WithLockSyncRender,
}

/** Apply with pinned members — force flag controls whether pinned members are included */
const WithPinnedMembersRender = (args: StoryArgs) => {
  const results = useMemo(
    () => applyForceFlag({ results: fixtures.applyWithPinned, force: args.force }),
    [args.force],
  )
  const stateConfig = useMemo(
    () => ({
      results,
      workspace: CI_WORKSPACE,
      options: buildSyncOptions({
        mode: 'apply',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      }),
      ...nestedFields({ all: args.all, root: CI_WORKSPACE.root, results }),
    }),
    [results, args.dryRun, args.verbose, args.all, args.force],
  )
  return (
    <TuiStoryPreview
      View={SyncView}
      app={SyncApp}
      initialState={sharedFixtures.createCommandState({
        mode: 'apply',
        overrides: args.interactive === true ? { _tag: 'Success', results: [] } : stateConfig,
      })}
      height={args.height}
      autoRun={args.interactive}
      playbackSpeed={args.playbackSpeed}
      tabs={ALL_OUTPUT_TABS}
      cwd={CI_WORKSPACE.root}
      command={buildSyncCommand({
        mode: 'apply',
        dryRun: args.dryRun,
        all: args.all,
        verbose: args.verbose,
        force: args.force,
      })}
      {...(args.interactive === true
        ? {
            timeline: sharedFixtures.createCommandTimeline({
              mode: 'apply',
              finalState: stateConfig,
            }),
          }
        : {})}
    />
  )
}

export const WithPinnedMembers: Story = {
  render: WithPinnedMembersRender,
}
