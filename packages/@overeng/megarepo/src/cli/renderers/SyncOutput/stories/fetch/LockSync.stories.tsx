/**
 * Lock sync stories for `mr fetch` — shows lock file update details.
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
import {
  createCommandState,
  createCommandTimeline,
  exampleLockSyncResults,
} from '../_fixtures.ts'
import { fetchFullNixSync, fetchLockSyncResults, fetchResults } from './_fixtures.ts'

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
  dryRun: boolean
  all: boolean
  verbose: boolean
}

export default {
  component: SyncView,
  title: 'CLI/Fetch/Lock Sync',
  parameters: { layout: 'fullscreen' },
  args: {
    ...defaultStoryArgs,
    dryRun: false,
    all: false,
    verbose: true,
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
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

/** Fetch with lock sync results (flake.lock/devenv.lock) */
export const WithLockSync: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: fetchResults,
        lockSyncResults: exampleLockSyncResults,
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
        initialState={createCommandState({
          mode: 'fetch',
          overrides: args.interactive === true ? { _tag: 'Success', results: [] } : stateConfig,
        })}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        cwd="~/workspace"
        command={`mr fetch${args.dryRun ? ' --dry-run' : ''}${args.all ? ' --all' : ''}${args.verbose ? ' --verbose' : ''}`}
        {...(args.interactive === true
          ? {
              timeline: createCommandTimeline({ mode: 'fetch', finalState: stateConfig }),
            }
          : {})}
      />
    )
  },
}

/** Fetch with lock input sync results (including flake.nix/devenv.yaml source file updates) */
export const WithLockInputSync: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: fetchResults,
        lockSyncResults: fetchLockSyncResults,
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
        initialState={createCommandState({
          mode: 'fetch',
          overrides: args.interactive === true ? { _tag: 'Success', results: [] } : stateConfig,
        })}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        cwd="~/workspace"
        command={`mr fetch${args.dryRun ? ' --dry-run' : ''}${args.all ? ' --all' : ''}${args.verbose ? ' --verbose' : ''}`}
        {...(args.interactive === true
          ? {
              timeline: createCommandTimeline({ mode: 'fetch', finalState: stateConfig }),
            }
          : {})}
      />
    )
  },
}

/** Fetch with full nix lock sync including source file (flake.nix, devenv.yaml) updates */
export const WithSourceFileSync: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: fetchResults,
        lockSyncResults: fetchFullNixSync,
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
        initialState={createCommandState({
          mode: 'fetch',
          overrides: args.interactive === true ? { _tag: 'Success', results: [] } : stateConfig,
        })}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        cwd="~/workspace"
        command={`mr fetch${args.dryRun ? ' --dry-run' : ''}${args.all ? ' --all' : ''}${args.verbose ? ' --verbose' : ''}`}
        {...(args.interactive === true
          ? {
              timeline: createCommandTimeline({ mode: 'fetch', finalState: stateConfig }),
            }
          : {})}
      />
    )
  },
}
