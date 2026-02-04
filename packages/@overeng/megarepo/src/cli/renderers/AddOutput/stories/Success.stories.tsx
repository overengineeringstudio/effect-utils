/**
 * Result state stories for AddOutput - various success scenarios.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useMemo } from 'react'

import type { OutputTab } from '@overeng/tui-react/storybook'
import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { AddApp } from '../mod.ts'
import { AddView } from '../view.tsx'
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
  // CLI flags
  sync: boolean
  name: string
  // Story scenario data
  source: string
}

export default {
  component: AddView,
  title: 'CLI/Add/Results',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: 'Output for the `mr add` command - success scenarios.',
      },
    },
  },
  args: {
    height: 400,
    interactive: false,
    playbackSpeed: 1,
    sync: false,
    name: 'effect',
    source: 'effect-ts/effect',
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
      description: 'Playback speed multiplier',
      control: { type: 'range', min: 0.5, max: 3, step: 0.5 },
      if: { arg: 'interactive' },
    },
    sync: {
      description: '--sync flag: sync the added repo immediately',
      control: { type: 'boolean' },
    },
    name: {
      description: '--name flag: override member name (defaults to repo name)',
      control: { type: 'text' },
    },
    source: {
      description: 'Repository reference (github shorthand, URL, or path)',
      control: { type: 'text' },
    },
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

/** Simple add without sync */
export const AddSimple: Story = {
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        member: args.name,
        source: args.source,
        synced: args.sync,
        syncStatus: 'cloned' as const,
      }),
      [args.name, args.source, args.sync],
    )
    return (
      <TuiStoryPreview
        View={AddView}
        app={AddApp}
        initialState={
          args.interactive ? fixtures.createIdleState() : fixtures.createSuccessState(stateConfig)
        }
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_TABS}
        {...(args.interactive ? { timeline: fixtures.createTimeline(stateConfig) } : {})}
      />
    )
  },
}

/** Add with sync - member cloned */
export const AddWithSync: Story = {
  args: { sync: true },
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        member: args.name,
        source: args.source,
        synced: args.sync,
        syncStatus: 'cloned' as const,
      }),
      [args.name, args.source, args.sync],
    )
    return (
      <TuiStoryPreview
        View={AddView}
        app={AddApp}
        initialState={
          args.interactive ? fixtures.createIdleState() : fixtures.createSuccessState(stateConfig)
        }
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_TABS}
        {...(args.interactive ? { timeline: fixtures.createTimeline(stateConfig) } : {})}
      />
    )
  },
}

/** Add with sync - existing member synced */
export const AddWithSyncExisting: Story = {
  args: { sync: true },
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        member: args.name,
        source: args.source,
        synced: args.sync,
        syncStatus: 'synced' as const,
      }),
      [args.name, args.source, args.sync],
    )
    return (
      <TuiStoryPreview
        View={AddView}
        app={AddApp}
        initialState={
          args.interactive ? fixtures.createIdleState() : fixtures.createSuccessState(stateConfig)
        }
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_TABS}
        {...(args.interactive ? { timeline: fixtures.createTimeline(stateConfig) } : {})}
      />
    )
  },
}

/** Add with sync - sync failed */
export const AddWithSyncError: Story = {
  args: { sync: true, name: 'private-repo', source: 'org/private-repo' },
  render: (args) => {
    const stateConfig = useMemo(
      () => ({
        member: args.name,
        source: args.source,
        synced: args.sync,
        syncStatus: 'error' as const,
      }),
      [args.name, args.source, args.sync],
    )
    return (
      <TuiStoryPreview
        View={AddView}
        app={AddApp}
        initialState={
          args.interactive ? fixtures.createIdleState() : fixtures.createSuccessState(stateConfig)
        }
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_TABS}
        {...(args.interactive ? { timeline: fixtures.createTimeline(stateConfig) } : {})}
      />
    )
  },
}
