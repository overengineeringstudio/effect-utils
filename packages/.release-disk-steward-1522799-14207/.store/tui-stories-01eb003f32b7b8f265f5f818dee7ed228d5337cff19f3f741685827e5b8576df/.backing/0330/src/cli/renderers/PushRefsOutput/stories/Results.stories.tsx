/**
 * Result stories for PushRefsOutput - successful ref propagation scenarios.
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
import { PushRefsApp } from '../mod.ts'
import { PushRefsView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
  dryRun: boolean
}

export default {
  component: PushRefsView,
  title: 'CLI/Config/PushRefs/Results',
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

/** All nested megarepo refs already aligned */
const AlreadyAlignedRender = (args: StoryArgs) => {
  const finalState = useMemo(() => fixtures.createAligned(), [])
  return (
    <TuiStoryPreview
      cwd="~/workspace"
      command={`mr config push-refs${args.dryRun === true ? ' --dry-run' : ''}`}
      View={PushRefsView}
      app={PushRefsApp}
      initialState={args.interactive === true ? { _tag: 'Idle' } : finalState}
      height={args.height}
      autoRun={args.interactive}
      playbackSpeed={args.playbackSpeed}
      tabs={ALL_OUTPUT_TABS}
      {...(args.interactive === true ? { timeline: fixtures.createTimeline(finalState) } : {})}
    />
  )
}

export const AlreadyAligned: Story = {
  render: AlreadyAlignedRender,
}

/** Single ref update in one nested megarepo */
const SingleUpdateRender = (args: StoryArgs) => {
  const finalState = useMemo(
    () => (args.dryRun === true ? fixtures.createDryRunSingle() : fixtures.createSingleUpdate()),
    [args.dryRun],
  )
  return (
    <TuiStoryPreview
      cwd="~/workspace"
      command={`mr config push-refs${args.dryRun === true ? ' --dry-run' : ''}`}
      View={PushRefsView}
      app={PushRefsApp}
      initialState={args.interactive === true ? { _tag: 'Idle' } : finalState}
      height={args.height}
      autoRun={args.interactive}
      playbackSpeed={args.playbackSpeed}
      tabs={ALL_OUTPUT_TABS}
      {...(args.interactive === true ? { timeline: fixtures.createTimeline(finalState) } : {})}
    />
  )
}

export const SingleUpdate: Story = {
  render: SingleUpdateRender,
}

/** Multiple ref updates across several nested megarepos */
const MultipleUpdatesRender = (args: StoryArgs) => {
  const finalState = useMemo(
    () =>
      args.dryRun === true ? fixtures.createDryRunMultiple() : fixtures.createMultipleUpdates(),
    [args.dryRun],
  )
  return (
    <TuiStoryPreview
      cwd="~/workspace"
      command={`mr config push-refs${args.dryRun === true ? ' --dry-run' : ''}`}
      View={PushRefsView}
      app={PushRefsApp}
      initialState={args.interactive === true ? { _tag: 'Idle' } : finalState}
      height={args.height}
      autoRun={args.interactive}
      playbackSpeed={args.playbackSpeed}
      tabs={ALL_OUTPUT_TABS}
      {...(args.interactive === true ? { timeline: fixtures.createTimeline(finalState) } : {})}
    />
  )
}

export const MultipleUpdates: Story = {
  render: MultipleUpdatesRender,
}

/** Update with genie file warning */
const WithGenieWarningRender = (args: StoryArgs) => {
  const finalState = useMemo(() => fixtures.createWithGenieWarning(), [])
  return (
    <TuiStoryPreview
      cwd="~/workspace"
      command={`mr config push-refs${args.dryRun === true ? ' --dry-run' : ''}`}
      View={PushRefsView}
      app={PushRefsApp}
      initialState={args.interactive === true ? { _tag: 'Idle' } : finalState}
      height={args.height}
      autoRun={args.interactive}
      playbackSpeed={args.playbackSpeed}
      tabs={ALL_OUTPUT_TABS}
      {...(args.interactive === true ? { timeline: fixtures.createTimeline(finalState) } : {})}
    />
  )
}

export const WithGenieWarning: Story = {
  render: WithGenieWarningRender,
}
