/**
 * Nested megarepo tree stories for `mr fetch` — shows `--all` tree rendering.
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
  exampleNestedLockSyncResults,
  exampleNestedSyncTrees,
} from '../_fixtures.ts'
import { fetchResults } from './_fixtures.ts'

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
  title: 'CLI/Fetch/Nested',
  parameters: { layout: 'fullscreen' },
  args: {
    ...defaultStoryArgs,
    dryRun: false,
    all: true,
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

/** --all tree rendering with nested members */
const TreeBasicRender = (args: StoryArgs) => {
  const stateConfig = useMemo(
    () => ({
      results: fetchResults,
      ...nestedFields(args.all),
      lockSyncResults: [...exampleLockSyncResults, ...exampleNestedLockSyncResults],
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

export const TreeBasic: Story = {
  render: TreeBasicRender,
}

/** --all --verbose: inline lock details within tree */
const TreeVerboseRender = (args: StoryArgs) => {
  const stateConfig = useMemo(
    () => ({
      results: fetchResults,
      ...nestedFields(args.all),
      lockSyncResults: [...exampleLockSyncResults, ...exampleNestedLockSyncResults],
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

export const TreeVerbose: Story = {
  args: { verbose: true },
  render: TreeVerboseRender,
}

/** --all --dry-run: tree rendering with dry-run markers */
const TreeDryRunRender = (args: StoryArgs) => {
  const stateConfig = useMemo(
    () => ({
      results: fetchResults,
      ...nestedFields(args.all),
      lockSyncResults: [...exampleLockSyncResults, ...exampleNestedLockSyncResults],
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

export const TreeDryRun: Story = {
  args: { dryRun: true },
  render: TreeDryRunRender,
}

/** --all off: shows [megarepo] badge and hint */
const MegarepoHintRender = (args: StoryArgs) => {
  const stateConfig = useMemo(
    () => ({
      results: fetchResults,
      ...nestedFields(args.all),
      lockSyncResults: exampleLockSyncResults,
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

export const MegarepoHint: Story = {
  args: { all: false },
  render: MegarepoHintRender,
}
