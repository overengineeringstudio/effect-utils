/**
 * Error stories for PinOutput - various error conditions.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useMemo } from 'react'

import { ALL_OUTPUT_TABS, commonArgTypes, defaultStoryArgs, TuiStoryPreview } from '@overeng/tui-react/storybook'

import { PinApp } from '../mod.ts'
import { PinView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
}

export default {
  component: PinView,
  title: 'CLI/Pin/Errors',
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    ...defaultStoryArgs,
  },
  argTypes: {
    ...commonArgTypes,
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

/** Error: Not running in a megarepo workspace */
export const ErrorNotInMegarepo: Story = {
  render: (args) => {
    const finalState = useMemo(() => fixtures.createErrorNotInMegarepo(), [])
    return (
      <TuiStoryPreview
        View={PinView}
        app={PinApp}
        initialState={args.interactive ? { _tag: 'Idle' } : finalState}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive ? { timeline: fixtures.createTimeline(finalState) } : {})}
      />
    )
  },
}

/** Error: Member not found in configuration */
export const ErrorMemberNotFound: Story = {
  render: (args) => {
    const finalState = useMemo(() => fixtures.createErrorMemberNotFound(), [])
    return (
      <TuiStoryPreview
        View={PinView}
        app={PinApp}
        initialState={args.interactive ? { _tag: 'Idle' } : finalState}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive ? { timeline: fixtures.createTimeline(finalState) } : {})}
      />
    )
  },
}

/** Error: Member not synced yet */
export const ErrorNotSynced: Story = {
  render: (args) => {
    const finalState = useMemo(() => fixtures.createErrorNotSynced(), [])
    return (
      <TuiStoryPreview
        View={PinView}
        app={PinApp}
        initialState={args.interactive ? { _tag: 'Idle' } : finalState}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive ? { timeline: fixtures.createTimeline(finalState) } : {})}
      />
    )
  },
}

/** Error: Cannot pin local path members */
export const ErrorLocalPath: Story = {
  render: (args) => {
    const finalState = useMemo(() => fixtures.createErrorLocalPath(), [])
    return (
      <TuiStoryPreview
        View={PinView}
        app={PinApp}
        initialState={args.interactive ? { _tag: 'Idle' } : finalState}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive ? { timeline: fixtures.createTimeline(finalState) } : {})}
      />
    )
  },
}

/** Error: Member not in lock file */
export const ErrorNotInLock: Story = {
  render: (args) => {
    const finalState = useMemo(() => fixtures.createErrorNotInLock(), [])
    return (
      <TuiStoryPreview
        View={PinView}
        app={PinApp}
        initialState={args.interactive ? { _tag: 'Idle' } : finalState}
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_OUTPUT_TABS}
        {...(args.interactive ? { timeline: fixtures.createTimeline(finalState) } : {})}
      />
    )
  },
}
