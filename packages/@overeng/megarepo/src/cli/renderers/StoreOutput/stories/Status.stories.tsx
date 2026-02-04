/**
 * Storybook stories for StoreStatus output.
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

// =============================================================================
// Meta
// =============================================================================

export default {
  component: StoreView,
  title: 'CLI/Store/Status',
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Output for the `mr store status` command. Shows store health and detects issues like ref mismatches, dirty worktrees, and orphaned worktrees.',
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
      description: 'Enable animated timeline playback (no animation for instant results)',
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

// =============================================================================
// Stories
// =============================================================================

export const Healthy: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createStatusState({
        repoCount: 2,
        worktreeCount: 2,
        worktrees: fixtures.healthyWorktrees,
      })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

export const HealthyWithDiskUsage: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createStatusState({
        repoCount: 11,
        worktreeCount: 15,
        diskUsage: '2.3 GB',
        worktrees: fixtures.healthyWorktrees,
      })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

export const MixedIssues: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createStatusState({
        repoCount: 4,
        worktreeCount: 6,
        worktrees: fixtures.mixedIssuesWorktrees,
      })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

export const RefMismatch: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createStatusState({
        repoCount: 2,
        worktreeCount: 2,
        worktrees: [
          {
            repo: 'github.com/livestorejs/livestore/',
            ref: 'dev',
            refType: 'heads',
            path: '/Users/dev/.megarepo/github.com/livestorejs/livestore/refs/heads/dev/',
            issues: [
              {
                type: 'ref_mismatch',
                severity: 'error',
                message: "path says 'dev' but HEAD is 'refactor/genie-igor-ci'",
              },
            ],
          },
          {
            repo: 'github.com/schickling/schickling-stiftung/',
            ref: 'main',
            refType: 'heads',
            path: '/Users/dev/.megarepo/github.com/schickling/schickling-stiftung/refs/heads/main/',
            issues: [
              {
                type: 'ref_mismatch',
                severity: 'error',
                message: "path says 'main' but HEAD is 'dotdot'",
              },
            ],
          },
        ],
      })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

export const DirtyWorktrees: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createStatusState({
        repoCount: 3,
        worktreeCount: 3,
        worktrees: [
          {
            repo: 'github.com/effect-ts/effect/',
            ref: 'main',
            refType: 'heads',
            path: '/Users/dev/.megarepo/github.com/effect-ts/effect/refs/heads/main/',
            issues: [{ type: 'dirty', severity: 'warning', message: '5 uncommitted changes' }],
          },
          {
            repo: 'github.com/overengineeringstudio/effect-utils/',
            ref: 'main',
            refType: 'heads',
            path: '/Users/dev/.megarepo/github.com/overengineeringstudio/effect-utils/refs/heads/main/',
            issues: [{ type: 'dirty', severity: 'warning', message: '36 uncommitted changes' }],
          },
          {
            repo: 'github.com/schickling/dotfiles/',
            ref: 'main',
            refType: 'heads',
            path: '/Users/dev/.megarepo/github.com/schickling/dotfiles/refs/heads/main/',
            issues: [
              { type: 'dirty', severity: 'warning', message: '9 uncommitted changes' },
              { type: 'unpushed', severity: 'warning', message: 'has unpushed commits' },
            ],
          },
        ],
      })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

export const OrphanedWorktrees: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createStatusState({
        repoCount: 4,
        worktreeCount: 5,
        worktrees: [
          {
            repo: 'github.com/effect-ts/effect/',
            ref: 'f4972eda6c3179070d0167a30985b760afa0a9f9',
            refType: 'commits',
            path: '/Users/dev/.megarepo/github.com/effect-ts/effect/refs/commits/f4972eda6c3179070d0167a30985b760afa0a9f9/',
            issues: [
              { type: 'orphaned', severity: 'info', message: 'not in current megarepo.lock' },
            ],
          },
          {
            repo: 'github.com/overtone-app/overtone/',
            ref: '2026-genie-refactor',
            refType: 'heads',
            path: '/Users/dev/.megarepo/github.com/overtone-app/overtone/refs/heads/2026-genie-refactor/',
            issues: [
              { type: 'orphaned', severity: 'info', message: 'not in current megarepo.lock' },
            ],
          },
          {
            repo: 'github.com/overtone-app/overtone/',
            ref: 'main',
            refType: 'heads',
            path: '/Users/dev/.megarepo/github.com/overtone-app/overtone/refs/heads/main/',
            issues: [
              { type: 'orphaned', severity: 'info', message: 'not in current megarepo.lock' },
            ],
          },
        ],
      })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

export const BrokenWorktrees: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createStatusState({
        repoCount: 2,
        worktreeCount: 2,
        worktrees: [
          {
            repo: 'github.com/effect-ts/effect/',
            ref: 'main',
            refType: 'heads',
            path: '/Users/dev/.megarepo/github.com/effect-ts/effect/refs/heads/main/',
            issues: [
              { type: 'broken_worktree', severity: 'error', message: '.git not found in worktree' },
            ],
          },
          {
            repo: 'github.com/overengineeringstudio/effect-utils/',
            ref: 'main',
            refType: 'heads',
            path: '/Users/dev/.megarepo/github.com/overengineeringstudio/effect-utils/refs/heads/main/',
            issues: [
              { type: 'missing_bare', severity: 'error', message: '.bare/ directory not found' },
            ],
          },
        ],
      })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

export const AllIssueTypes: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createStatusState({
        repoCount: 6,
        worktreeCount: 8,
        diskUsage: '4.7 GB',
        worktrees: [
          {
            repo: 'github.com/livestorejs/livestore/',
            ref: 'dev',
            refType: 'heads',
            path: '/Users/dev/.megarepo/github.com/livestorejs/livestore/refs/heads/dev/',
            issues: [
              {
                type: 'ref_mismatch',
                severity: 'error',
                message: "path says 'dev' but HEAD is 'refactor/genie-igor-ci'",
              },
              { type: 'dirty', severity: 'warning', message: '27 uncommitted changes' },
              { type: 'orphaned', severity: 'info', message: 'not in current megarepo.lock' },
            ],
          },
          {
            repo: 'github.com/effect-ts/effect/',
            ref: 'main',
            refType: 'heads',
            path: '/Users/dev/.megarepo/github.com/effect-ts/effect/refs/heads/main/',
            issues: [
              { type: 'broken_worktree', severity: 'error', message: '.git not found in worktree' },
            ],
          },
          {
            repo: 'github.com/overengineeringstudio/effect-utils/',
            ref: 'main',
            refType: 'heads',
            path: '/Users/dev/.megarepo/github.com/overengineeringstudio/effect-utils/refs/heads/main/',
            issues: [
              { type: 'dirty', severity: 'warning', message: '36 uncommitted changes' },
              { type: 'unpushed', severity: 'warning', message: 'has unpushed commits' },
            ],
          },
          {
            repo: 'github.com/schickling/dotfiles/',
            ref: 'improve-agent-manager',
            refType: 'heads',
            path: '/Users/dev/.megarepo/github.com/schickling/dotfiles/refs/heads/improve-agent-manager/',
            issues: [
              { type: 'orphaned', severity: 'info', message: 'not in current megarepo.lock' },
            ],
          },
        ],
      })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

export const Empty: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createStatusState({
        repoCount: 0,
        worktreeCount: 0,
        worktrees: [],
      })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

export const LargeStore: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createStatusState({
        repoCount: 25,
        worktreeCount: 87,
        diskUsage: '12.4 GB',
        worktrees: [
          ...fixtures.mixedIssuesWorktrees,
          {
            repo: 'github.com/private/repo1/',
            ref: 'main',
            refType: 'heads',
            path: '/Users/dev/.megarepo/github.com/private/repo1/refs/heads/main/',
            issues: [
              { type: 'orphaned', severity: 'info', message: 'not in current megarepo.lock' },
            ],
          },
          {
            repo: 'github.com/private/repo2/',
            ref: 'dev',
            refType: 'heads',
            path: '/Users/dev/.megarepo/github.com/private/repo2/refs/heads/dev/',
            issues: [
              { type: 'dirty', severity: 'warning', message: '3 uncommitted changes' },
              { type: 'orphaned', severity: 'info', message: 'not in current megarepo.lock' },
            ],
          },
        ],
      })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}
