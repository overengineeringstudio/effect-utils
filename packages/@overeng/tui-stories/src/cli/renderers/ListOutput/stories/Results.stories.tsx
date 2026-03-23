/** List command output stories */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import {
  ALL_OUTPUT_TABS,
  commonArgTypes,
  defaultStoryArgs,
  TuiStoryPreview,
} from '@overeng/tui-react/storybook'

import { ListApp } from '../app.ts'
import { ListView } from '../view.tsx'
import * as fixtures from './_fixtures.ts'

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
}

export default {
  component: ListView,
  title: 'tui-stories/List',
  parameters: { layout: 'fullscreen' },
  args: defaultStoryArgs,
  argTypes: commonArgTypes,
} as Meta

type Story = StoryObj<StoryArgs>

/** Default list output with component and CLI stories */
export const Default: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={ListView}
      app={ListApp}
      initialState={fixtures.createDefaultState()}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
      command="tui-stories list --path packages/@overeng/megarepo"
    />
  ),
}

/** Small package with few stories */
export const SmallPackage: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={ListView}
      app={ListApp}
      initialState={fixtures.createSmallState()}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
      command="tui-stories list --path packages/@overeng/tui-react"
    />
  ),
}

/** Empty result — no stories found */
export const Empty: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={ListView}
      app={ListApp}
      initialState={fixtures.createEmptyState()}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
      command="tui-stories list --path packages/@overeng/nonexistent"
    />
  ),
}

/** Large package with many story groups */
export const LargePackage: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={ListView}
      app={ListApp}
      initialState={fixtures.createLargeState()}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
      command="tui-stories list --path packages/@overeng/megarepo"
    />
  ),
}
