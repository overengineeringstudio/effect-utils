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
  title: 'CLI/Pin/Results',
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

/** Pin member to a specific ref (tag/branch) */
export const PinWithRef: Story = {
  render: (args) => {
    const finalState = useMemo(() => fixtures.createPinSuccessWithRef(), [])
    return (
      <TuiStoryPreview
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
  },
}

/** Pin member to current commit */
export const PinCurrentCommit: Story = {
  render: (args) => {
    const finalState = useMemo(() => fixtures.createPinSuccessWithCommit(), [])
    return (
      <TuiStoryPreview
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
  },
}

/** Unpin member */
export const Unpin: Story = {
  render: (args) => {
    const finalState = useMemo(() => fixtures.createUnpinSuccess(), [])
    return (
      <TuiStoryPreview
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
  },
}

/** Member already pinned */
export const AlreadyPinned: Story = {
  render: (args) => {
    const finalState = useMemo(() => fixtures.createAlreadyPinned(), [])
    return (
      <TuiStoryPreview
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
  },
}

/** Member already unpinned */
export const AlreadyUnpinned: Story = {
  render: (args) => {
    const finalState = useMemo(() => fixtures.createAlreadyUnpinned(), [])
    return (
      <TuiStoryPreview
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
  },
}
