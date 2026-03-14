/**
 * Warning stories for PinOutput - non-blocking issues.
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
  dryRun: boolean
}

export default {
  component: PinView,
  title: 'CLI/Pin/Warnings',
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    ...defaultStoryArgs,
    dryRun: false,
  },
  argTypes: {
    ...commonArgTypes,
    dryRun: { description: '--dry-run: preview changes without applying', control: { type: 'boolean' } },
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

/** Warning: Worktree for pinned ref not available */
export const WarningWorktreeNotAvailable: Story = {
  render: (args) => {
    const finalState = useMemo(() => fixtures.createWarningWorktreeNotAvailable(), [])
    return (
      <TuiStoryPreview
        cwd="~/workspace"
        command={`mr pin${args.dryRun ? ' --dry-run' : ''}`}
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

/** Warning: Member was removed from config */
export const WarningMemberRemovedFromConfig: Story = {
  render: (args) => {
    const finalState = useMemo(() => fixtures.createWarningMemberRemovedFromConfig(), [])
    return (
      <TuiStoryPreview
        cwd="~/workspace"
        command={`mr pin${args.dryRun ? ' --dry-run' : ''}`}
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
