/**
 * Storybook stories for StoreWorktreeNew output.
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
  title: 'CLI/Store/WorktreeNew',
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Output for the `mr store worktree new` command. Shows worktree creation results and errors.',
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
// Success Stories
// =============================================================================

export const Success: Story = {
  render: (args) => (
    <TuiStoryPreview
      cwd="~/workspace"
      command="mr store worktree new"
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createWorktreeNewState({
        source: 'effect-ts/effect',
        ref: 'main',
        commit: 'abc1234567890',
        path: '/Users/me/.megarepo/store/github.com/effect-ts/effect/refs/heads/main',
        autoBootstrap: false,
        branchCreated: false,
      })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

export const AutoBootstrap: Story = {
  render: (args) => (
    <TuiStoryPreview
      cwd="~/workspace"
      command="mr store worktree new"
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createWorktreeNewState({
        source: 'effect-ts/effect',
        ref: 'feat/new-feature',
        commit: 'def456789012',
        path: '/Users/me/.megarepo/store/github.com/effect-ts/effect/refs/heads/feat/new-feature',
        autoBootstrap: true,
        branchCreated: true,
      })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

export const BranchCreated: Story = {
  render: (args) => (
    <TuiStoryPreview
      cwd="~/workspace"
      command="mr store worktree new"
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createWorktreeNewState({
        source: 'schickling/dotfiles',
        ref: 'feat/experiment',
        commit: '789abc012345',
        path: '/Users/me/.megarepo/store/github.com/schickling/dotfiles/refs/heads/feat/experiment',
        autoBootstrap: false,
        branchCreated: true,
      })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

// =============================================================================
// Error Stories
// =============================================================================

export const AlreadyExists: Story = {
  render: (args) => (
    <TuiStoryPreview
      cwd="~/workspace"
      command="mr store worktree new"
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createErrorState({
        error: 'worktree_exists',
        message:
          'Worktree already exists at /Users/me/.megarepo/store/github.com/effect-ts/effect/refs/heads/main',
      })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}

export const RepoNotFound: Story = {
  render: (args) => (
    <TuiStoryPreview
      cwd="~/workspace"
      command="mr store worktree new"
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createErrorState({
        error: 'invalid_source',
        message: "Invalid repository: 'not-a-valid-repo'",
        source: 'not-a-valid-repo',
      })}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  ),
}
