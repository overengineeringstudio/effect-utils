/**
 * Storybook stories for StoreFetch output.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useMemo } from 'react'

import {
  ALL_OUTPUT_TABS,
  commonArgTypes,
  defaultStoryArgs,
  TuiStoryPreview,
} from '@overeng/tui-react/storybook'

import { flagArgTypes } from '../../_story-constants.ts'
import { StoreApp, StoreView } from '../mod.ts'
import * as fixtures from './_fixtures.ts'

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
  dryRun: boolean
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
    ...defaultStoryArgs,
    dryRun: false,
  },
  argTypes: {
    ...commonArgTypes,
    dryRun: flagArgTypes.dryRun,
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

// =============================================================================
// Stories
// =============================================================================

const SuccessRender = (args: StoryArgs) => {
  const stateConfig = useMemo(
    () => ({
      results: [
        { path: 'github.com/effect-ts/effect', status: 'fetched' as const },
        { path: 'github.com/acme-org/dev-tools', status: 'fetched' as const },
        { path: 'github.com/alice/dotfiles', status: 'fetched' as const },
      ],
      elapsedMs: 1850,
    }),
    [],
  )
  return (
    <TuiStoryPreview
      cwd="~/workspace"
      command={`mr store fetch${args.dryRun === true ? ' --dry-run' : ''}`}
      View={StoreView}
      app={StoreApp}
      initialState={
        args.interactive === true
          ? fixtures.createFetchState({ results: [], elapsedMs: 0 })
          : fixtures.createFetchState(stateConfig)
      }
      height={args.height}
      autoRun={args.interactive}
      playbackSpeed={args.playbackSpeed}
      tabs={ALL_OUTPUT_TABS}
      {...(args.interactive === true
        ? { timeline: fixtures.createFetchTimeline(stateConfig) }
        : {})}
    />
  )
}

export const Success: Story = {
  render: SuccessRender,
}

const WithErrorsRender = (args: StoryArgs) => {
  const stateConfig = useMemo(
    () => ({
      results: fixtures.exampleFetchResults,
      elapsedMs: 3200,
    }),
    [],
  )
  return (
    <TuiStoryPreview
      cwd="~/workspace"
      command={`mr store fetch${args.dryRun === true ? ' --dry-run' : ''}`}
      View={StoreView}
      app={StoreApp}
      initialState={
        args.interactive === true
          ? fixtures.createFetchState({ results: [], elapsedMs: 0 })
          : fixtures.createFetchState(stateConfig)
      }
      height={args.height}
      autoRun={args.interactive}
      playbackSpeed={args.playbackSpeed}
      tabs={ALL_OUTPUT_TABS}
      {...(args.interactive === true
        ? { timeline: fixtures.createFetchTimeline(stateConfig) }
        : {})}
    />
  )
}

export const WithErrors: Story = {
  render: WithErrorsRender,
}

const AllErrorsRender = (args: StoryArgs) => {
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
      cwd="~/workspace"
      command={`mr store fetch${args.dryRun === true ? ' --dry-run' : ''}`}
      View={StoreView}
      app={StoreApp}
      initialState={
        args.interactive === true
          ? fixtures.createFetchState({ results: [], elapsedMs: 0 })
          : fixtures.createFetchState(stateConfig)
      }
      height={args.height}
      autoRun={args.interactive}
      playbackSpeed={args.playbackSpeed}
      tabs={ALL_OUTPUT_TABS}
      {...(args.interactive === true
        ? { timeline: fixtures.createFetchTimeline(stateConfig) }
        : {})}
    />
  )
}

export const AllErrors: Story = {
  render: AllErrorsRender,
}
