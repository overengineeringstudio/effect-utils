/**
 * Error stories for PinOutput - various error conditions.
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
  title: 'CLI/Config/Pin/Errors',
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

/** Error: Not running in a megarepo workspace */
const ErrorNotInMegarepoRender = (args: StoryArgs) => {
  const finalState = useMemo(() => fixtures.createErrorNotInMegarepo(), [])
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

export const ErrorNotInMegarepo: Story = {
  render: ErrorNotInMegarepoRender,
}

/** Error: Member not found in configuration */
const ErrorMemberNotFoundRender = (args: StoryArgs) => {
  const finalState = useMemo(() => fixtures.createErrorMemberNotFound(), [])
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

export const ErrorMemberNotFound: Story = {
  render: ErrorMemberNotFoundRender,
}

/** Error: Member not synced yet */
const ErrorNotSyncedRender = (args: StoryArgs) => {
  const finalState = useMemo(() => fixtures.createErrorNotSynced(), [])
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

export const ErrorNotSynced: Story = {
  render: ErrorNotSyncedRender,
}

/** Error: Cannot pin local path members */
const ErrorLocalPathRender = (args: StoryArgs) => {
  const finalState = useMemo(() => fixtures.createErrorLocalPath(), [])
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

export const ErrorLocalPath: Story = {
  render: ErrorLocalPathRender,
}

/** Error: Member not in lock file */
const ErrorNotInLockRender = (args: StoryArgs) => {
  const finalState = useMemo(() => fixtures.createErrorNotInLock(), [])
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

export const ErrorNotInLock: Story = {
  render: ErrorNotInLockRender,
}
