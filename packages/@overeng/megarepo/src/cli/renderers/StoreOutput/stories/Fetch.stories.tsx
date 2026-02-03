/**
 * Storybook stories for StoreFetch output.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useMemo } from 'react'

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
  title: 'CLI/Store/Fetch',
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Output for the `mr store fetch` command. Shows fetch results for all repositories.',
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

// =============================================================================
// Stories
// =============================================================================

export const Success: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: [
          { path: 'github.com/effect-ts/effect', status: 'fetched' as const },
          { path: 'github.com/overengineeringstudio/effect-utils', status: 'fetched' as const },
          { path: 'github.com/schickling/dotfiles', status: 'fetched' as const },
        ],
        elapsedMs: 1850,
      }),
      [],
    )
    return (
      <TuiStoryPreview
        View={StoreView}
        app={StoreApp}
        initialState={
          args.interactive
            ? fixtures.createFetchState({ results: [], elapsedMs: 0 })
            : fixtures.createFetchState(stateConfig)
        }
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_TABS}
        {...(args.interactive ? { timeline: fixtures.createFetchTimeline(stateConfig) } : {})}
      />
    )
  },
}

export const WithErrors: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        results: fixtures.exampleFetchResults,
        elapsedMs: 3200,
      }),
      [],
    )
    return (
      <TuiStoryPreview
        View={StoreView}
        app={StoreApp}
        initialState={
          args.interactive
            ? fixtures.createFetchState({ results: [], elapsedMs: 0 })
            : fixtures.createFetchState(stateConfig)
        }
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_TABS}
        {...(args.interactive ? { timeline: fixtures.createFetchTimeline(stateConfig) } : {})}
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
            path: 'github.com/effect-ts/effect',
            status: 'error' as const,
            message: 'network timeout',
          },
          {
            path: 'github.com/private/repo',
            status: 'error' as const,
            message: 'authentication failed',
          },
        ],
        elapsedMs: 30500,
      }),
      [],
    )
    return (
      <TuiStoryPreview
        View={StoreView}
        app={StoreApp}
        initialState={
          args.interactive
            ? fixtures.createFetchState({ results: [], elapsedMs: 0 })
            : fixtures.createFetchState(stateConfig)
        }
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_TABS}
        {...(args.interactive ? { timeline: fixtures.createFetchTimeline(stateConfig) } : {})}
      />
    )
  },
}
