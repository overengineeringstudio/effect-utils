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

import { MEGAREPO_MEMBERS, WORKSPACE } from '../../../_story-constants.ts'
import { SyncApp } from '../../mod.ts'
import { SyncView } from '../../view.tsx'
import {
  createCommandState,
  createCommandTimeline,
  exampleNestedLockSyncResults,
  exampleNestedSyncTrees,
} from '../_fixtures.ts'
import { fetchLockSyncResults, fetchResults } from './_fixtures.ts'

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
    dryRun: {
      description: '--dry-run: show what would happen without making changes',
      control: { type: 'boolean' },
    },
    all: {
      description: '--all: sync nested megarepos recursively',
      control: { type: 'boolean' },
    },
    verbose: {
      description: '--verbose: show detailed lock sync information',
      control: { type: 'boolean' },
    },
    force: {
      description: '--force: include pinned members',
      control: { type: 'boolean' },
    },
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

/** --all tree rendering with nested members */
export const TreeBasic: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: fetchResults,
        ...nestedFields(args.all),
        lockSyncResults: [...fetchLockSyncResults, ...exampleNestedLockSyncResults],
        options: {
          mode: 'fetch' as const,
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
          force: args.force,
        },
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

/** --all --verbose: inline lock details within tree */
export const TreeVerbose: Story = {
  args: { verbose: true },
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: fetchResults,
        ...nestedFields(args.all),
        lockSyncResults: [...fetchLockSyncResults, ...exampleNestedLockSyncResults],
        options: {
          mode: 'fetch' as const,
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
          force: args.force,
        },
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

/** --all --dry-run: tree rendering with dry-run markers */
export const TreeDryRun: Story = {
  args: { dryRun: true },
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: fetchResults,
        ...nestedFields(args.all),
        lockSyncResults: [...fetchLockSyncResults, ...exampleNestedLockSyncResults],
        options: {
          mode: 'fetch' as const,
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
          force: args.force,
        },
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

/** --all off: shows [megarepo] badge and hint */
export const MegarepoHint: Story = {
  args: { all: false },
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: fetchResults,
        ...nestedFields(args.all),
        lockSyncResults: fetchLockSyncResults,
        options: {
          mode: 'fetch' as const,
          dryRun: args.dryRun,
          all: args.all,
          verbose: args.verbose,
          force: args.force,
        },
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
