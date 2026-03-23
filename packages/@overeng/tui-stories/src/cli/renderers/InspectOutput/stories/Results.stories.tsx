/** Inspect command output stories */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import {
  ALL_OUTPUT_TABS,
  commonArgTypes,
  defaultStoryArgs,
  TuiStoryPreview,
} from '@overeng/tui-react/storybook'

import { InspectApp } from '../app.ts'
import { InspectView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
}

export default {
  component: InspectView,
  title: 'tui-stories/Inspect',
  parameters: { layout: 'fullscreen' },
  args: defaultStoryArgs,
  argTypes: commonArgTypes,
} satisfies Meta

type Story = StoryObj<StoryArgs>

/** Story with many args and timeline */
export const WithArgs: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={InspectView}
      app={InspectApp}
      initialState={fixtures.createWithArgsState()}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
      command="tui-stories inspect CLI/Exec/Running/RunningVerboseParallel --path packages/@overeng/megarepo"
    />
  ),
}

/** Simple story with few args, no timeline */
export const Simple: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={InspectView}
      app={InspectApp}
      initialState={fixtures.createSimpleState()}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
      command="tui-stories inspect CLI/Status/Basic/Default --path packages/@overeng/megarepo"
    />
  ),
}

/** Component story with no args */
export const NoArgs: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={InspectView}
      app={InspectApp}
      initialState={fixtures.createNoArgsState()}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
      command="tui-stories inspect Components/StatusIcon/SuccessCheck --path packages/@overeng/megarepo"
    />
  ),
}
