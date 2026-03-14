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
}

export default {
  component: SyncView,
  title: 'CLI/Apply/Results',
  parameters: { layout: 'fullscreen' },
  args: {
    ...defaultStoryArgs,
    dryRun: false,
    verbose: false,
  },
  argTypes: {
    ...commonArgTypes,
    dryRun: {
      description: '--dry-run: show what commits would be checked out without making changes',
      control: { type: 'boolean' },
    },
    verbose: {
      description: '--verbose: show detailed commit information',
      control: { type: 'boolean' },
    },
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

/** All members applied from lockfile (typical CI scenario) */
export const FullApply: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: fixtures.applyResults,
        workspace: { name: 'mr-all-blue', root: '/home/runner/work/mr-all-blue' },
        options: {
          mode: 'apply' as const,
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
        initialState={sharedFixtures.createCommandState({
          mode: 'apply',
          overrides: args.interactive === true ? { _tag: 'Success', results: [] } : stateConfig,
        })}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        cwd="/home/runner/work/mr-all-blue"
        command={`mr apply${args.dryRun === true ? ' --dry-run' : ''}${args.verbose === true ? ' --verbose' : ''}`}
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
  },
}

/** Some members already at locked commit */
export const PartialApply: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: fixtures.applyPartial,
        options: {
          mode: 'apply' as const,
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
        initialState={sharedFixtures.createCommandState({
          mode: 'apply',
          overrides: args.interactive === true ? { _tag: 'Success', results: [] } : stateConfig,
        })}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        cwd="~/workspace"
        command={`mr apply${args.dryRun === true ? ' --dry-run' : ''}${args.verbose === true ? ' --verbose' : ''}`}
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
  },
}

/** Apply failures — stale lockfile, missing commits */
export const WithErrors: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        _tag: 'Error' as const,
        results: fixtures.applyWithErrors,
        workspace: { name: 'mr-all-blue', root: '/home/runner/work/mr-all-blue' },
        options: {
          mode: 'apply' as const,
          dryRun: args.dryRun,
          all: false,
          verbose: args.verbose,
        },
        syncErrorCount: 2,
        syncErrors: [
          {
            megarepoRoot: '/home/runner/work/mr-all-blue',
            memberName: 'effect-utils',
            message: 'commit f0e1d2c not found — run mr fetch',
          },
          {
            megarepoRoot: '/home/runner/work/mr-all-blue',
            memberName: 'dotfiles',
            message: 'repository not found',
          },
        ],
      }),
      [args.dryRun, args.verbose],
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
        cwd="/home/runner/work/mr-all-blue"
        command={`mr apply${args.dryRun === true ? ' --dry-run' : ''}${args.verbose === true ? ' --verbose' : ''}`}
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
  },
}
