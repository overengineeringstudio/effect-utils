/**
 * Result state stories for PinOutput - various pin/unpin completion scenarios.
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
import { PinApp } from '../mod.ts'
import { PinView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
  dryRun: boolean
}

export default {
  component: PinView,
  title: 'CLI/Config/Pin/Results',
  parameters: {
    layout: 'fullscreen',
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

/** Pin member to a specific ref (tag/branch) */
const PinWithRefRender = (args: StoryArgs) => {
  const finalState = useMemo(() => fixtures.createPinSuccessWithRef(), [])
  return (
    <TuiStoryPreview
      cwd="~/workspace"
      command={`mr config pin${args.dryRun === true ? ' --dry-run' : ''}`}
      View={PinView}
      app={PinApp}
      initialState={args.interactive === true ? { _tag: 'Idle' } : finalState}
      height={args.height}
      autoRun={args.interactive}
      playbackSpeed={args.playbackSpeed}
      tabs={ALL_OUTPUT_TABS}
      {...(args.interactive === true ? { timeline: fixtures.createTimeline(finalState) } : {})}
    />
  )
}

export const PinWithRef: Story = {
  render: PinWithRefRender,
}

/** Pin member to current commit */
const PinCurrentCommitRender = (args: StoryArgs) => {
  const finalState = useMemo(() => fixtures.createPinSuccessWithCommit(), [])
  return (
    <TuiStoryPreview
      cwd="~/workspace"
      command={`mr config pin${args.dryRun === true ? ' --dry-run' : ''}`}
      View={PinView}
      app={PinApp}
      initialState={args.interactive === true ? { _tag: 'Idle' } : finalState}
      height={args.height}
      autoRun={args.interactive}
      playbackSpeed={args.playbackSpeed}
      tabs={ALL_OUTPUT_TABS}
      {...(args.interactive === true ? { timeline: fixtures.createTimeline(finalState) } : {})}
    />
  )
}

export const PinCurrentCommit: Story = {
  render: PinCurrentCommitRender,
}

/** Unpin member */
const UnpinRender = (args: StoryArgs) => {
  const finalState = useMemo(() => fixtures.createUnpinSuccess(), [])
  return (
    <TuiStoryPreview
      cwd="~/workspace"
      command={`mr config pin${args.dryRun === true ? ' --dry-run' : ''}`}
      View={PinView}
      app={PinApp}
      initialState={args.interactive === true ? { _tag: 'Idle' } : finalState}
      height={args.height}
      autoRun={args.interactive}
      playbackSpeed={args.playbackSpeed}
      tabs={ALL_OUTPUT_TABS}
      {...(args.interactive === true ? { timeline: fixtures.createTimeline(finalState) } : {})}
    />
  )
}

export const Unpin: Story = {
  render: UnpinRender,
}

/** Member already pinned */
const AlreadyPinnedRender = (args: StoryArgs) => {
  const finalState = useMemo(() => fixtures.createAlreadyPinned(), [])
  return (
    <TuiStoryPreview
      cwd="~/workspace"
      command={`mr config pin${args.dryRun === true ? ' --dry-run' : ''}`}
      View={PinView}
      app={PinApp}
      initialState={args.interactive === true ? { _tag: 'Idle' } : finalState}
      height={args.height}
      autoRun={args.interactive}
      playbackSpeed={args.playbackSpeed}
      tabs={ALL_OUTPUT_TABS}
      {...(args.interactive === true ? { timeline: fixtures.createTimeline(finalState) } : {})}
    />
  )
}

export const AlreadyPinned: Story = {
  render: AlreadyPinnedRender,
}

/** Member already unpinned */
const AlreadyUnpinnedRender = (args: StoryArgs) => {
  const finalState = useMemo(() => fixtures.createAlreadyUnpinned(), [])
  return (
    <TuiStoryPreview
      cwd="~/workspace"
      command={`mr config pin${args.dryRun === true ? ' --dry-run' : ''}`}
      View={PinView}
      app={PinApp}
      initialState={args.interactive === true ? { _tag: 'Idle' } : finalState}
      height={args.height}
      autoRun={args.interactive}
      playbackSpeed={args.playbackSpeed}
      tabs={ALL_OUTPUT_TABS}
      {...(args.interactive === true ? { timeline: fixtures.createTimeline(finalState) } : {})}
    />
  )
}

export const AlreadyUnpinned: Story = {
  render: AlreadyUnpinnedRender,
}

/** Dry run with full details - ref change, symlink change, worktree creation */
const DryRunFullRender = (args: StoryArgs) => {
  const finalState = useMemo(() => fixtures.createDryRunFull(), [])
  return (
    <TuiStoryPreview
      cwd="~/workspace"
      command={`mr config pin${args.dryRun === true ? ' --dry-run' : ''}`}
      View={PinView}
      app={PinApp}
      initialState={args.interactive === true ? { _tag: 'Idle' } : finalState}
      height={args.height}
      autoRun={args.interactive}
      playbackSpeed={args.playbackSpeed}
      tabs={ALL_OUTPUT_TABS}
      {...(args.interactive === true ? { timeline: fixtures.createTimeline(finalState) } : {})}
    />
  )
}

export const DryRunFull: Story = {
  args: { dryRun: true },
  render: DryRunFullRender,
}

/** Dry run with minimal changes - just pinned flag */
const DryRunSimpleRender = (args: StoryArgs) => {
  const finalState = useMemo(() => fixtures.createDryRunSimple(), [])
  return (
    <TuiStoryPreview
      cwd="~/workspace"
      command={`mr config pin${args.dryRun === true ? ' --dry-run' : ''}`}
      View={PinView}
      app={PinApp}
      initialState={args.interactive === true ? { _tag: 'Idle' } : finalState}
      height={args.height}
      autoRun={args.interactive}
      playbackSpeed={args.playbackSpeed}
      tabs={ALL_OUTPUT_TABS}
      {...(args.interactive === true ? { timeline: fixtures.createTimeline(finalState) } : {})}
    />
  )
}

export const DryRunSimple: Story = {
  args: { dryRun: true },
  render: DryRunSimpleRender,
}
