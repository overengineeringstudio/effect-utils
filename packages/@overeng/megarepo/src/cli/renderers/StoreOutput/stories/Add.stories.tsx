/**
 * Storybook stories for StoreAdd output.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import type { OutputTab } from '@overeng/tui-react/storybook'
import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { StoreApp, StoreView } from '../mod.ts'
import * as fixtures from './_fixtures.ts'

const ALL_TABS: OutputTab[] = [
  'tty',
  'alt-screen',
  'ci',
  'ci-plain',
  'pipe',
  'log',
  'json',
  'ndjson',
]

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
  title: 'CLI/Store/Add',
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component: 'Output for the `mr store add` command. Shows add results and errors.',
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
// Error Stories
// =============================================================================

export const InvalidSource: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createErrorState({
        error: 'invalid_source',
        message: "Invalid source: 'not-a-valid-source'",
        source: 'not-a-valid-source',
      })}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}

export const LocalPath: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createErrorState({
        error: 'local_path',
        message: 'Local paths are not supported. Use a remote URL or owner/repo format.',
      })}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}

export const NoUrl: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createErrorState({
        error: 'no_url',
        message: 'No URL provided',
      })}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}

// =============================================================================
// Success Stories
// =============================================================================

export const SuccessNew: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createAddState({
        status: 'added',
        source: 'effect-ts/effect',
        ref: 'main',
        commit: 'abc1234567890',
        path: '/Users/me/.megarepo/store/github.com/effect-ts/effect/refs/main',
      })}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}

export const SuccessExisting: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createAddState({
        status: 'already_exists',
        source: 'effect-ts/effect',
        ref: 'main',
        commit: 'abc1234567890',
        path: '/Users/me/.megarepo/store/github.com/effect-ts/effect/refs/main',
      })}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}

export const SuccessWithRef: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createAddState({
        status: 'added',
        source: 'effect-ts/effect#feat/new-feature',
        ref: 'feat/new-feature',
        commit: 'def456789012',
        path: '/Users/me/.megarepo/store/github.com/effect-ts/effect/refs/feat/new-feature',
      })}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}

export const SuccessNoCommit: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={StoreView}
      app={StoreApp}
      initialState={fixtures.createAddState({
        status: 'added',
        source: 'effect-ts/effect',
        ref: 'v3.0.0',
        path: '/Users/me/.megarepo/store/github.com/effect-ts/effect/refs/v3.0.0',
      })}
      height={args.height}
      tabs={ALL_TABS}
    />
  ),
}
