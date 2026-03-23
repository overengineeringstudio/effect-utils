/** Render command error stories */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import {
  ALL_OUTPUT_TABS,
  commonArgTypes,
  defaultStoryArgs,
  TuiStoryPreview,
} from '@overeng/tui-react/storybook'

import { RenderApp } from '../app.ts'
import { RenderView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
}

export default {
  component: RenderView,
  title: 'tui-stories/Render/Errors',
  parameters: { layout: 'fullscreen' },
  args: defaultStoryArgs,
  argTypes: commonArgTypes,
} as Meta

type Story = StoryObj<StoryArgs>

/** Story not found error */
export const StoryNotFound: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={RenderView}
      app={RenderApp}
      initialState={fixtures.createErrorState()}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
      command='tui-stories render "CLI/NonExistent/Missing" --path packages/@overeng/megarepo'
    />
  ),
}
