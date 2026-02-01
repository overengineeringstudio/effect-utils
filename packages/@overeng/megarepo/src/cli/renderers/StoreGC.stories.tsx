/**
 * Storybook stories for StoreGc output.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import {
  StoreView,
  StoreState,
  StoreAction,
  storeReducer,
  type StoreGcResult,
  type StoreGcWarning,
} from './StoreOutput/mod.ts'

// =============================================================================
// Example Data
// =============================================================================

const exampleGcResults: StoreGcResult[] = [
  {
    repo: 'github.com/effect-ts/effect',
    ref: 'feat/old-branch',
    path: '/store/...',
    status: 'removed',
  },
  {
    repo: 'github.com/effect-ts/effect',
    ref: 'main',
    path: '/store/...',
    status: 'skipped_in_use',
  },
  {
    repo: 'github.com/overengineeringstudio/effect-utils',
    ref: 'dev',
    path: '/store/...',
    status: 'skipped_dirty',
  },
]

// =============================================================================
// State Factory
// =============================================================================

const createGcState = (opts: {
  results: StoreGcResult[]
  dryRun: boolean
  warning?: StoreGcWarning
  showForceHint?: boolean
}): typeof StoreState.Type => ({
  _tag: 'Gc',
  basePath: '/Users/dev/.megarepo',
  results: opts.results,
  dryRun: opts.dryRun,
  warning: opts.warning,
  showForceHint: opts.showForceHint ?? true,
})

// =============================================================================
// Meta
// =============================================================================

const meta = {
  title: 'CLI/Store/GC',
  component: StoreView,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Output for the `mr store gc` command. Shows garbage collection results for worktrees.',
      },
    },
  },
} satisfies Meta<typeof StoreView>

export default meta

type Story = StoryObj<typeof meta>

// =============================================================================
// Stories
// =============================================================================

export const Mixed: Story = {
  render: () => (
    <TuiStoryPreview
      View={StoreView}
      stateSchema={StoreState}
      actionSchema={StoreAction}
      reducer={storeReducer}
      initialState={createGcState({
        results: exampleGcResults,
        dryRun: false,
      })}
    />
  ),
}

export const DryRun: Story = {
  render: () => (
    <TuiStoryPreview
      View={StoreView}
      stateSchema={StoreState}
      actionSchema={StoreAction}
      reducer={storeReducer}
      initialState={createGcState({
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
        dryRun: true,
      })}
    />
  ),
}

export const OnlyCurrentMegarepo: Story = {
  render: () => (
    <TuiStoryPreview
      View={StoreView}
      stateSchema={StoreState}
      actionSchema={StoreAction}
      reducer={storeReducer}
      initialState={createGcState({
        results: exampleGcResults,
        dryRun: false,
        warning: { type: 'only_current_megarepo' },
      })}
    />
  ),
}

export const NotInMegarepo: Story = {
  render: () => (
    <TuiStoryPreview
      View={StoreView}
      stateSchema={StoreState}
      actionSchema={StoreAction}
      reducer={storeReducer}
      initialState={createGcState({
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
        dryRun: true,
        warning: { type: 'not_in_megarepo' },
      })}
    />
  ),
}

export const CustomWarning: Story = {
  render: () => (
    <TuiStoryPreview
      View={StoreView}
      stateSchema={StoreState}
      actionSchema={StoreAction}
      reducer={storeReducer}
      initialState={createGcState({
        results: exampleGcResults,
        dryRun: false,
        warning: { type: 'custom', message: 'Custom warning message for edge case' },
      })}
    />
  ),
}

export const Empty: Story = {
  render: () => (
    <TuiStoryPreview
      View={StoreView}
      stateSchema={StoreState}
      actionSchema={StoreAction}
      reducer={storeReducer}
      initialState={createGcState({
        results: [],
        dryRun: false,
      })}
    />
  ),
}

export const AllSkipped: Story = {
  render: () => (
    <TuiStoryPreview
      View={StoreView}
      stateSchema={StoreState}
      actionSchema={StoreAction}
      reducer={storeReducer}
      initialState={createGcState({
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
        dryRun: false,
      })}
    />
  ),
}

export const AllRemoved: Story = {
  render: () => (
    <TuiStoryPreview
      View={StoreView}
      stateSchema={StoreState}
      actionSchema={StoreAction}
      reducer={storeReducer}
      initialState={createGcState({
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
        dryRun: false,
      })}
    />
  ),
}

export const AllErrors: Story = {
  render: () => (
    <TuiStoryPreview
      View={StoreView}
      stateSchema={StoreState}
      actionSchema={StoreAction}
      reducer={storeReducer}
      initialState={createGcState({
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
        dryRun: false,
      })}
    />
  ),
}

export const ManyInUse: Story = {
  render: () => (
    <TuiStoryPreview
      View={StoreView}
      stateSchema={StoreState}
      actionSchema={StoreAction}
      reducer={storeReducer}
      initialState={createGcState({
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
        dryRun: false,
      })}
    />
  ),
}

export const DirtyWithDetails: Story = {
  render: () => (
    <TuiStoryPreview
      View={StoreView}
      stateSchema={StoreState}
      actionSchema={StoreAction}
      reducer={storeReducer}
      initialState={createGcState({
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
        dryRun: false,
        showForceHint: true,
      })}
    />
  ),
}

export const DryRunForceMode: Story = {
  render: () => (
    <TuiStoryPreview
      View={StoreView}
      stateSchema={StoreState}
      actionSchema={StoreAction}
      reducer={storeReducer}
      initialState={createGcState({
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
        dryRun: true,
        showForceHint: false,
      })}
    />
  ),
}

export const LargeCleanup: Story = {
  render: () => (
    <TuiStoryPreview
      View={StoreView}
      stateSchema={StoreState}
      actionSchema={StoreAction}
      reducer={storeReducer}
      initialState={createGcState({
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
        dryRun: false,
        warning: { type: 'only_current_megarepo' },
      })}
    />
  ),
}
