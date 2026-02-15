/**
 * Storybook stories for StoreGc output.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useMemo } from 'react'

import {
  ALL_OUTPUT_TABS,
  commonArgTypes,
  defaultStoryArgs,
  TuiStoryPreview,
} from '@overeng/tui-react/storybook'

import { StoreApp, StoreView } from '../mod.ts'
import * as fixtures from './_fixtures.ts'

// =============================================================================
// Meta
// =============================================================================

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
  dryRun: boolean
  force: boolean
  all: boolean
}

export default {
  component: StoreView,
  title: 'CLI/Store/GC',
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    ...defaultStoryArgs,
    dryRun: false,
    force: false,
    all: false,
  },
  argTypes: {
    ...commonArgTypes,
    dryRun: {
      description: '--dry-run flag: show what would be removed without removing',
      control: { type: 'boolean' },
    },
    force: {
      description: '--force flag: remove dirty worktrees too',
      control: { type: 'boolean' },
    },
    all: {
      description: '--all flag: remove all worktrees',
      control: { type: 'boolean' },
    },
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

// =============================================================================
// Stories
// =============================================================================

export const Mixed: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: fixtures.exampleGcResults,
        dryRun: args.dryRun,
        force: args.force,
        all: args.all,
        showForceHint: !args.force,
      }),
      [args.dryRun, args.force, args.all],
    )
    return (
      <TuiStoryPreview
        View={StoreView}
        app={StoreApp}
        initialState={fixtures.createGcState(
          args.interactive === true ? { ...stateConfig, results: [] } : stateConfig,
        )}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive === true ? { timeline: fixtures.createGcTimeline(stateConfig) } : {})}
      />
    )
  },
}

export const DryRun: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: [
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'feat/old-branch',
            path: '/store/...',
            status: 'removed' as const,
          },
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'fix/deprecated',
            path: '/store/...',
            status: 'removed' as const,
          },
        ],
        dryRun: true,
        force: args.force,
        all: args.all,
        showForceHint: !args.force,
      }),
      [args.force, args.all],
    )
    return (
      <TuiStoryPreview
        View={StoreView}
        app={StoreApp}
        initialState={fixtures.createGcState(
          args.interactive === true ? { ...stateConfig, results: [] } : stateConfig,
        )}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive === true ? { timeline: fixtures.createGcTimeline(stateConfig) } : {})}
      />
    )
  },
}

export const OnlyCurrentMegarepo: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: fixtures.exampleGcResults,
        dryRun: args.dryRun,
        force: args.force,
        all: args.all,
        warning: { type: 'only_current_megarepo' as const },
        showForceHint: !args.force,
      }),
      [args.dryRun, args.force, args.all],
    )
    return (
      <TuiStoryPreview
        View={StoreView}
        app={StoreApp}
        initialState={fixtures.createGcState(
          args.interactive === true ? { ...stateConfig, results: [] } : stateConfig,
        )}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive === true ? { timeline: fixtures.createGcTimeline(stateConfig) } : {})}
      />
    )
  },
}

export const NotInMegarepo: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: [
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'main',
            path: '/store/...',
            status: 'removed' as const,
          },
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'feat/old',
            path: '/store/...',
            status: 'removed' as const,
          },
        ],
        dryRun: true,
        force: args.force,
        all: args.all,
        warning: { type: 'not_in_megarepo' as const },
        showForceHint: !args.force,
      }),
      [args.force, args.all],
    )
    return (
      <TuiStoryPreview
        View={StoreView}
        app={StoreApp}
        initialState={fixtures.createGcState(
          args.interactive === true ? { ...stateConfig, results: [] } : stateConfig,
        )}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive === true ? { timeline: fixtures.createGcTimeline(stateConfig) } : {})}
      />
    )
  },
}

export const CustomWarning: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: fixtures.exampleGcResults,
        dryRun: args.dryRun,
        force: args.force,
        all: args.all,
        warning: { type: 'custom' as const, message: 'Custom warning message for edge case' },
        showForceHint: !args.force,
      }),
      [args.dryRun, args.force, args.all],
    )
    return (
      <TuiStoryPreview
        View={StoreView}
        app={StoreApp}
        initialState={fixtures.createGcState(
          args.interactive === true ? { ...stateConfig, results: [] } : stateConfig,
        )}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive === true ? { timeline: fixtures.createGcTimeline(stateConfig) } : {})}
      />
    )
  },
}

export const Empty: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: [] as fixtures.StoreGcResult[],
        dryRun: args.dryRun,
        force: args.force,
        all: args.all,
        showForceHint: !args.force,
      }),
      [args.dryRun, args.force, args.all],
    )
    return (
      <TuiStoryPreview
        View={StoreView}
        app={StoreApp}
        initialState={fixtures.createGcState(stateConfig)}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive === true ? { timeline: fixtures.createGcTimeline(stateConfig) } : {})}
      />
    )
  },
}

export const AllSkipped: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: [
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'main',
            path: '/store/...',
            status: 'skipped_in_use' as const,
          },
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'dev',
            path: '/store/...',
            status: 'skipped_dirty' as const,
          },
          {
            repo: 'github.com/overengineeringstudio/effect-utils',
            ref: 'main',
            path: '/store/...',
            status: 'skipped_in_use' as const,
          },
        ],
        dryRun: args.dryRun,
        force: args.force,
        all: args.all,
        showForceHint: !args.force,
      }),
      [args.dryRun, args.force, args.all],
    )
    return (
      <TuiStoryPreview
        View={StoreView}
        app={StoreApp}
        initialState={fixtures.createGcState(
          args.interactive === true ? { ...stateConfig, results: [] } : stateConfig,
        )}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive === true ? { timeline: fixtures.createGcTimeline(stateConfig) } : {})}
      />
    )
  },
}

export const AllRemoved: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: [
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'feat/old-1',
            path: '/store/...',
            status: 'removed' as const,
          },
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'feat/old-2',
            path: '/store/...',
            status: 'removed' as const,
          },
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'feat/old-3',
            path: '/store/...',
            status: 'removed' as const,
          },
          {
            repo: 'github.com/overengineeringstudio/effect-utils',
            ref: 'experiment',
            path: '/store/...',
            status: 'removed' as const,
          },
        ],
        dryRun: args.dryRun,
        force: args.force,
        all: args.all,
        showForceHint: !args.force,
      }),
      [args.dryRun, args.force, args.all],
    )
    return (
      <TuiStoryPreview
        View={StoreView}
        app={StoreApp}
        initialState={fixtures.createGcState(
          args.interactive === true ? { ...stateConfig, results: [] } : stateConfig,
        )}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive === true ? { timeline: fixtures.createGcTimeline(stateConfig) } : {})}
      />
    )
  },
}

export const AllErrors: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: [
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'main',
            path: '/store/...',
            status: 'error' as const,
            message: 'Permission denied',
          },
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'dev',
            path: '/store/...',
            status: 'error' as const,
            message: 'Directory not found',
          },
          {
            repo: 'github.com/overengineeringstudio/effect-utils',
            ref: 'main',
            path: '/store/...',
            status: 'error' as const,
            message: 'Lock file in use',
          },
        ],
        dryRun: args.dryRun,
        force: args.force,
        all: args.all,
        showForceHint: !args.force,
      }),
      [args.dryRun, args.force, args.all],
    )
    return (
      <TuiStoryPreview
        View={StoreView}
        app={StoreApp}
        initialState={fixtures.createGcState(
          args.interactive === true ? { ...stateConfig, results: [] } : stateConfig,
        )}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive === true ? { timeline: fixtures.createGcTimeline(stateConfig) } : {})}
      />
    )
  },
}

export const ManyInUse: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: [
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'main',
            path: '/store/...',
            status: 'skipped_in_use' as const,
          },
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'dev',
            path: '/store/...',
            status: 'skipped_in_use' as const,
          },
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'feat/a',
            path: '/store/...',
            status: 'skipped_in_use' as const,
          },
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'feat/b',
            path: '/store/...',
            status: 'skipped_in_use' as const,
          },
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'feat/c',
            path: '/store/...',
            status: 'skipped_in_use' as const,
          },
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'feat/d',
            path: '/store/...',
            status: 'skipped_in_use' as const,
          },
          {
            repo: 'github.com/overengineeringstudio/effect-utils',
            ref: 'main',
            path: '/store/...',
            status: 'skipped_in_use' as const,
          },
          {
            repo: 'github.com/overengineeringstudio/effect-utils',
            ref: 'dev',
            path: '/store/...',
            status: 'skipped_in_use' as const,
          },
        ],
        dryRun: args.dryRun,
        force: args.force,
        all: args.all,
        showForceHint: !args.force,
      }),
      [args.dryRun, args.force, args.all],
    )
    return (
      <TuiStoryPreview
        View={StoreView}
        app={StoreApp}
        initialState={fixtures.createGcState(
          args.interactive === true ? { ...stateConfig, results: [] } : stateConfig,
        )}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive === true ? { timeline: fixtures.createGcTimeline(stateConfig) } : {})}
      />
    )
  },
}

export const DirtyWithDetails: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: [
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'feature-branch',
            path: '/store/...',
            status: 'skipped_dirty' as const,
            message: '5 uncommitted change(s)',
          },
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'wip-branch',
            path: '/store/...',
            status: 'skipped_dirty' as const,
            message: 'has unpushed commits',
          },
          {
            repo: 'github.com/overengineeringstudio/effect-utils',
            ref: 'experimental',
            path: '/store/...',
            status: 'skipped_dirty' as const,
            message: '12 uncommitted change(s)',
          },
        ],
        dryRun: args.dryRun,
        force: args.force,
        all: args.all,
        showForceHint: !args.force,
      }),
      [args.dryRun, args.force, args.all],
    )
    return (
      <TuiStoryPreview
        View={StoreView}
        app={StoreApp}
        initialState={fixtures.createGcState(
          args.interactive === true ? { ...stateConfig, results: [] } : stateConfig,
        )}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive === true ? { timeline: fixtures.createGcTimeline(stateConfig) } : {})}
      />
    )
  },
}

export const DryRunForceMode: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: [
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'dirty-branch',
            path: '/store/...',
            status: 'removed' as const,
          },
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'clean-branch',
            path: '/store/...',
            status: 'removed' as const,
          },
        ],
        dryRun: true,
        force: args.force,
        all: args.all,
        showForceHint: false,
      }),
      [args.force, args.all],
    )
    return (
      <TuiStoryPreview
        View={StoreView}
        app={StoreApp}
        initialState={fixtures.createGcState(
          args.interactive === true ? { ...stateConfig, results: [] } : stateConfig,
        )}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive === true ? { timeline: fixtures.createGcTimeline(stateConfig) } : {})}
      />
    )
  },
}

export const LargeCleanup: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: [
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'feat/old-1',
            path: '/store/...',
            status: 'removed' as const,
          },
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'feat/old-2',
            path: '/store/...',
            status: 'removed' as const,
          },
          {
            repo: 'github.com/effect-ts/effect',
            ref: 'feat/old-3',
            path: '/store/...',
            status: 'removed' as const,
          },
          {
            repo: 'github.com/overengineeringstudio/effect-utils',
            ref: 'wip',
            path: '/store/...',
            status: 'skipped_dirty' as const,
            message: '3 uncommitted change(s)',
          },
          {
            repo: 'github.com/livestorejs/livestore',
            ref: 'main',
            path: '/store/...',
            status: 'skipped_in_use' as const,
          },
          {
            repo: 'github.com/livestorejs/livestore',
            ref: 'dev',
            path: '/store/...',
            status: 'skipped_in_use' as const,
          },
          {
            repo: 'github.com/private/repo',
            ref: 'main',
            path: '/store/...',
            status: 'error' as const,
            message: 'Permission denied',
          },
        ],
        dryRun: args.dryRun,
        force: args.force,
        all: args.all,
        warning: { type: 'only_current_megarepo' as const },
        showForceHint: !args.force,
      }),
      [args.dryRun, args.force, args.all],
    )
    return (
      <TuiStoryPreview
        View={StoreView}
        app={StoreApp}
        initialState={fixtures.createGcState(
          args.interactive === true ? { ...stateConfig, results: [] } : stateConfig,
        )}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive === true ? { timeline: fixtures.createGcTimeline(stateConfig) } : {})}
      />
    )
  },
}
