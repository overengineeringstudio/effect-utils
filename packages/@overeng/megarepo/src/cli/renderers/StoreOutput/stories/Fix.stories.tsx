/**
 * Storybook stories for StoreFix output.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { ALL_OUTPUT_TABS, TuiStoryPreview } from '@overeng/tui-react/storybook'

import { StoreApp, StoreView } from '../mod.ts'
import * as fixtures from './_fixtures.ts'

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
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
    height: 400,
    interactive: false,
    playbackSpeed: 1,
  },
  argTypes: {
    height: {
      description: 'Terminal height in pixels',
      control: { type: 'range', min: 200, max: 600, step: 50 },
    },
    interactive: {
      description: 'Enable animated timeline playback',
      control: { type: 'boolean' },
    },
    playbackSpeed: {
      description: 'Playback speed multiplier (when interactive)',
      control: { type: 'range', min: 0.5, max: 3, step: 0.5 },
      if: { arg: 'interactive' },
    },
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

/** No issues found - store is healthy */
export const NoIssues: Story = {
  render: (args) => (
    <TuiStoryPreview
      command="mr store fix"
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createFixState({
        results: [],
        dryRun: false,
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
      command="mr store fix"
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createFixState({
        results: fixtures.fixResultsMixed,
        dryRun: false,
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
      command="mr store fix"
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createFixState({
        results: fixtures.fixResultsAllFixed,
        dryRun: false,
        noIssues: false,
      })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

/** Dry run mode - shows what would be fixed */
export const DryRun: Story = {
  render: (args) => (
    <TuiStoryPreview
      command="mr store fix --dry-run"
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createFixState({
        results: fixtures.fixResultsDryRun,
        dryRun: true,
        noIssues: false,
      })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}
