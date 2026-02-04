/**
 * Error stories for PinOutput - various error conditions.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useMemo } from 'react'

import type { OutputTab } from '@overeng/tui-react/storybook'
import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { PinApp } from '../mod.ts'
import { PinView } from '../view.tsx'
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

export default {
  component: PinView,
  title: 'CLI/Pin/Errors',
  parameters: {
    layout: 'fullscreen',
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
      description: 'Playback speed multiplier',
      control: { type: 'range', min: 0.5, max: 3, step: 0.5 },
      if: { arg: 'interactive' },
    },
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
        tabs={ALL_TABS}
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
        tabs={ALL_TABS}
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
        tabs={ALL_TABS}
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
        tabs={ALL_TABS}
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
        tabs={ALL_TABS}
        {...(args.interactive ? { timeline: fixtures.createTimeline(finalState) } : {})}
      />
    )
  },
}
