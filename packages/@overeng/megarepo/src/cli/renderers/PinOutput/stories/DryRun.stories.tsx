/**
 * Dry run stories for PinOutput - preview what would happen without making changes.
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
  title: 'CLI/Pin/DryRun',
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

/** Dry run with full details - ref change, symlink change, worktree creation */
export const DryRunFull: Story = {
  render: (args) => {
    const finalState = useMemo(() => fixtures.createDryRunFull(), [])
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

/** Dry run with minimal changes - just pinned flag */
export const DryRunSimple: Story = {
  render: (args) => {
    const finalState = useMemo(() => fixtures.createDryRunSimple(), [])
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
