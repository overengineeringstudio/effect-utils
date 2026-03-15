/**
 * Error stories for PushRefsOutput - error conditions.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useMemo } from 'react'

import {
  ALL_OUTPUT_TABS,
  commonArgTypes,
  defaultStoryArgs,
  TuiStoryPreview,
} from '@overeng/tui-react/storybook'

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
  title: 'CLI/Config/PushRefs/Errors',
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    ...defaultStoryArgs,
    dryRun: false,
  },
  argTypes: {
    ...commonArgTypes,
    dryRun: {
      description: '--dry-run: preview changes without writing files',
      control: { type: 'boolean' },
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
  },
}
