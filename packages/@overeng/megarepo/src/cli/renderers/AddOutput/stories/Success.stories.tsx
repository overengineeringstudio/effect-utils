/**
 * Result state stories for AddOutput - various success scenarios.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useMemo } from 'react'

import {
  ALL_OUTPUT_TABS,
  commonArgTypes,
  defaultStoryArgs,
  TuiStoryPreview,
} from '@overeng/tui-react/storybook'

import { AddApp } from '../mod.ts'
import { AddView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

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
    ...defaultStoryArgs,
    sync: true,
    name: 'core-lib',
    source: 'alice/core-lib',
  },
  argTypes: {
    ...commonArgTypes,
    sync: {
      description: '--sync/--no-sync flag: sync the added repo immediately (default: true)',
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

/** Default add behavior - adds and syncs (clones) the member */
const AddDefaultRender = (args: StoryArgs) => {
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
      cwd="~/workspace"
      command="mr add"
      View={AddView}
      app={AddApp}
      initialState={
        args.interactive === true
          ? fixtures.createIdleState()
          : fixtures.createSuccessState(stateConfig)
      }
      height={args.height}
      autoRun={args.interactive}
      playbackSpeed={args.playbackSpeed}
      tabs={ALL_OUTPUT_TABS}
      {...(args.interactive === true ? { timeline: fixtures.createTimeline(stateConfig) } : {})}
    />
  )
}

export const AddDefault: Story = {
  render: AddDefaultRender,
}

/** Add with --no-sync flag - skips syncing */
const AddNoSyncRender = (args: StoryArgs) => {
  const stateConfig = useMemo(
    () => ({
      member: args.name,
      source: args.source,
      synced: false,
    }),
    [args.name, args.source],
  )
  return (
    <TuiStoryPreview
      cwd="~/workspace"
      command="mr add --no-sync"
      View={AddView}
      app={AddApp}
      initialState={
        args.interactive === true
          ? fixtures.createIdleState()
          : fixtures.createSuccessState(stateConfig)
      }
      height={args.height}
      autoRun={args.interactive}
      playbackSpeed={args.playbackSpeed}
      tabs={ALL_OUTPUT_TABS}
      {...(args.interactive === true ? { timeline: fixtures.createTimeline(stateConfig) } : {})}
    />
  )
}

export const AddNoSync: Story = {
  args: { sync: false },
  render: AddNoSyncRender,
}

/** Add with sync - member cloned (explicit --sync flag) */
const AddWithSyncClonedRender = (args: StoryArgs) => {
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
      cwd="~/workspace"
      command="mr add"
      View={AddView}
      app={AddApp}
      initialState={
        args.interactive === true
          ? fixtures.createIdleState()
          : fixtures.createSuccessState(stateConfig)
      }
      height={args.height}
      autoRun={args.interactive}
      playbackSpeed={args.playbackSpeed}
      tabs={ALL_OUTPUT_TABS}
      {...(args.interactive === true ? { timeline: fixtures.createTimeline(stateConfig) } : {})}
    />
  )
}

export const AddWithSyncCloned: Story = {
  args: { sync: true },
  render: AddWithSyncClonedRender,
}

/** Add with sync - existing member synced */
const AddWithSyncExistingRender = (args: StoryArgs) => {
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
      cwd="~/workspace"
      command="mr add"
      View={AddView}
      app={AddApp}
      initialState={
        args.interactive === true
          ? fixtures.createIdleState()
          : fixtures.createSuccessState(stateConfig)
      }
      height={args.height}
      autoRun={args.interactive}
      playbackSpeed={args.playbackSpeed}
      tabs={ALL_OUTPUT_TABS}
      {...(args.interactive === true ? { timeline: fixtures.createTimeline(stateConfig) } : {})}
    />
  )
}

export const AddWithSyncExisting: Story = {
  args: { sync: true },
  render: AddWithSyncExistingRender,
}

/** Add with sync - sync failed */
const AddWithSyncErrorRender = (args: StoryArgs) => {
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
      cwd="~/workspace"
      command="mr add"
      View={AddView}
      app={AddApp}
      initialState={
        args.interactive === true
          ? fixtures.createIdleState()
          : fixtures.createSuccessState(stateConfig)
      }
      height={args.height}
      autoRun={args.interactive}
      playbackSpeed={args.playbackSpeed}
      tabs={ALL_OUTPUT_TABS}
      {...(args.interactive === true ? { timeline: fixtures.createTimeline(stateConfig) } : {})}
    />
  )
}

export const AddWithSyncError: Story = {
  args: { sync: true, name: 'private-repo', source: 'org/private-repo' },
  render: AddWithSyncErrorRender,
}
