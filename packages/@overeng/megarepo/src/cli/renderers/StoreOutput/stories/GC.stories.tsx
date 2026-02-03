/**
 * Storybook stories for StoreGc output.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { StoreApp, StoreView } from '../mod.ts'
import * as fixtures from './_fixtures.ts'

// =============================================================================
// Meta
// =============================================================================

type StoryArgs = {
  height?: number
  dryRun: boolean
  force: boolean
}

export default {
  component: StoreView,
  title: 'CLI/Store/GC',
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Output for the `mr store gc` command. Shows garbage collection results for worktrees.',
      },
    },
  },
  args: {
    dryRun: false,
    force: false,
  },
  argTypes: {
    dryRun: {
      description: '--dry-run flag: show what would be removed without removing',
      control: { type: 'boolean' },
    },
    force: {
      description: '--force flag: remove dirty worktrees too',
      control: { type: 'boolean' },
    },
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

// =============================================================================
// Stories
// =============================================================================

export const Mixed: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createGcState({
        results: fixtures.exampleGcResults,
        dryRun: args.dryRun,
        showForceHint: !args.force,
      })}
    />
  ),
}

export const DryRun: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createGcState({
        results: [
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'feat/old-branch',
            path: '/store/...',
            status: 'removed',
          },
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'fix/deprecated',
            path: '/store/...',
            status: 'removed',
          },
        ],
        dryRun: args.dryRun || true,
        showForceHint: !args.force,
      })}
    />
  ),
}

export const OnlyCurrentMegarepo: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createGcState({
        results: fixtures.exampleGcResults,
        dryRun: args.dryRun,
        warning: { type: 'only_current_megarepo' },
        showForceHint: !args.force,
      })}
    />
  ),
}

export const NotInMegarepo: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createGcState({
        results: [
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'main',
            path: '/store/...',
            status: 'removed',
          },
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'feat/old',
            path: '/store/...',
            status: 'removed',
          },
        ],
        dryRun: args.dryRun || true,
        warning: { type: 'not_in_megarepo' },
        showForceHint: !args.force,
      })}
    />
  ),
}

export const CustomWarning: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createGcState({
        results: fixtures.exampleGcResults,
        dryRun: args.dryRun,
        warning: { type: 'custom', message: 'Custom warning message for edge case' },
        showForceHint: !args.force,
      })}
    />
  ),
}

export const Empty: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createGcState({
        results: [],
        dryRun: args.dryRun,
        showForceHint: !args.force,
      })}
    />
  ),
}

export const AllSkipped: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createGcState({
        results: [
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'main',
            path: '/store/...',
            status: 'skipped_in_use',
          },
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'dev',
            path: '/store/...',
            status: 'skipped_dirty',
          },
          {
            repo: 'github.com/overengineeringstudio/effect-utils',
            ref: 'main',
            path: '/store/...',
            status: 'skipped_in_use',
          },
        ],
        dryRun: args.dryRun,
        showForceHint: !args.force,
      })}
    />
  ),
}

export const AllRemoved: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createGcState({
        results: [
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'feat/old-1',
            path: '/store/...',
            status: 'removed',
          },
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'feat/old-2',
            path: '/store/...',
            status: 'removed',
          },
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'feat/old-3',
            path: '/store/...',
            status: 'removed',
          },
          {
            repo: 'github.com/overengineeringstudio/effect-utils',
            ref: 'experiment',
            path: '/store/...',
            status: 'removed',
          },
        ],
        dryRun: args.dryRun,
        showForceHint: !args.force,
      })}
    />
  ),
}

export const AllErrors: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createGcState({
        results: [
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'main',
            path: '/store/...',
            status: 'error',
            message: 'Permission denied',
          },
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'dev',
            path: '/store/...',
            status: 'error',
            message: 'Directory not found',
          },
          {
            repo: 'github.com/overengineeringstudio/effect-utils',
            ref: 'main',
            path: '/store/...',
            status: 'error',
            message: 'Lock file in use',
          },
        ],
        dryRun: args.dryRun,
        showForceHint: !args.force,
      })}
    />
  ),
}

export const ManyInUse: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createGcState({
        results: [
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'main',
            path: '/store/...',
            status: 'skipped_in_use',
          },
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'dev',
            path: '/store/...',
            status: 'skipped_in_use',
          },
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'feat/a',
            path: '/store/...',
            status: 'skipped_in_use',
          },
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'feat/b',
            path: '/store/...',
            status: 'skipped_in_use',
          },
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'feat/c',
            path: '/store/...',
            status: 'skipped_in_use',
          },
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'feat/d',
            path: '/store/...',
            status: 'skipped_in_use',
          },
          {
            repo: 'github.com/overengineeringstudio/effect-utils',
            ref: 'main',
            path: '/store/...',
            status: 'skipped_in_use',
          },
          {
            repo: 'github.com/overengineeringstudio/effect-utils',
            ref: 'dev',
            path: '/store/...',
            status: 'skipped_in_use',
          },
        ],
        dryRun: args.dryRun,
        showForceHint: !args.force,
      })}
    />
  ),
}

export const DirtyWithDetails: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createGcState({
        results: [
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'feature-branch',
            path: '/store/...',
            status: 'skipped_dirty',
            message: '5 uncommitted change(s)',
          },
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'wip-branch',
            path: '/store/...',
            status: 'skipped_dirty',
            message: 'has unpushed commits',
          },
          {
            repo: 'github.com/overengineeringstudio/effect-utils',
            ref: 'experimental',
            path: '/store/...',
            status: 'skipped_dirty',
            message: '12 uncommitted change(s)',
          },
        ],
        dryRun: args.dryRun,
        showForceHint: !args.force,
      })}
    />
  ),
}

export const DryRunForceMode: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createGcState({
        results: [
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'dirty-branch',
            path: '/store/...',
            status: 'removed',
          },
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'clean-branch',
            path: '/store/...',
            status: 'removed',
          },
        ],
        dryRun: args.dryRun || true,
        showForceHint: false,
      })}
    />
  ),
}

export const LargeCleanup: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createGcState({
        results: [
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'feat/old-1',
            path: '/store/...',
            status: 'removed',
          },
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'feat/old-2',
            path: '/store/...',
            status: 'removed',
          },
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'feat/old-3',
            path: '/store/...',
            status: 'removed',
          },
          {
            repo: 'github.com/overengineeringstudio/effect-utils',
            ref: 'wip',
            path: '/store/...',
            status: 'skipped_dirty',
            message: '3 uncommitted change(s)',
          },
          {
            repo: 'github.com/livestorejs/livestore',
            ref: 'main',
            path: '/store/...',
            status: 'skipped_in_use',
          },
          {
            repo: 'github.com/livestorejs/livestore',
            ref: 'dev',
            path: '/store/...',
            status: 'skipped_in_use',
          },
          {
            repo: 'github.com/private/repo',
            ref: 'main',
            path: '/store/...',
            status: 'error',
            message: 'Permission denied',
          },
        ],
        dryRun: args.dryRun,
        warning: { type: 'only_current_megarepo' },
        showForceHint: !args.force,
      })}
    />
  ),
}
