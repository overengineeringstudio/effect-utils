/**
 * Storybook stories for StoreFix output.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import {
  ALL_OUTPUT_TABS,
  commonArgTypes,
  defaultStoryArgs,
  TuiStoryPreview,
} from '@overeng/tui-react/storybook'

import { StoreApp, StoreView } from '../mod.ts'
import * as fixtures from './_fixtures.ts'

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
  dryRun: boolean
}

export default {
  component: StoreView,
  title: 'CLI/Store/Fix',
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Output for the `mr store fix` command. Shows fix results for store hygiene issues.',
      },
    },
  },
  args: {
    ...defaultStoryArgs,
    dryRun: false,
  },
  argTypes: {
    ...commonArgTypes,
    dryRun: {
      description: '--dry-run: preview fixes without applying',
      control: { type: 'boolean' },
    },
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

/** No issues found - store is healthy */
export const NoIssues: Story = {
  render: (args) => (
    <TuiStoryPreview
      cwd="~/workspace"
      command={`mr store fix${args.dryRun ? ' --dry-run' : ''}`}
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createFixState({
        results: [],
        dryRun: args.dryRun,
        noIssues: true,
      })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

/** Mixed results - some fixed, some errors */
export const MixedResults: Story = {
  render: (args) => (
    <TuiStoryPreview
      cwd="~/workspace"
      command={`mr store fix${args.dryRun ? ' --dry-run' : ''}`}
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createFixState({
        results: fixtures.fixResultsMixed,
        dryRun: args.dryRun,
        noIssues: false,
      })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

/** All issues fixed successfully */
export const AllFixed: Story = {
  render: (args) => (
    <TuiStoryPreview
      cwd="~/workspace"
      command={`mr store fix${args.dryRun ? ' --dry-run' : ''}`}
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createFixState({
        results: fixtures.fixResultsAllFixed,
        dryRun: args.dryRun,
        noIssues: false,
      })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

/** Dry run preview with skipped results showing what would be fixed */
export const DryRunPreview: Story = {
  args: { dryRun: true },
  render: (args) => (
    <TuiStoryPreview
      cwd="~/workspace"
      command={`mr store fix${args.dryRun ? ' --dry-run' : ''}`}
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createFixState({
        results: fixtures.fixResultsDryRun,
        dryRun: args.dryRun,
        noIssues: false,
      })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}
