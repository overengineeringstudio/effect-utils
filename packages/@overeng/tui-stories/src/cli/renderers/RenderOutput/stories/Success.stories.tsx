/** Render command success stories — showing rendered story output */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import {
  ALL_OUTPUT_TABS,
  commonArgTypes,
  createInteractiveProps,
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
  title: 'tui-stories/Render/Success',
  parameters: { layout: 'fullscreen' },
  args: defaultStoryArgs,
  argTypes: commonArgTypes,
} satisfies Meta

type Story = StoryObj<StoryArgs>

/** Rendered mr status output */
export const StatusOutput: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={RenderView}
      app={RenderApp}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
      command="tui-stories render CLI/Status/Basic/Default --path packages/@overeng/megarepo --output log"
      {...createInteractiveProps({
        args,
        staticState: fixtures.createStatusRender(),
        idleState: fixtures.createRenderingState(),
        createTimeline: fixtures.createTimeline,
      })}
    />
  ),
}

/** Rendered mr exec output (final timeline state) */
export const ExecOutput: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={RenderView}
      app={RenderApp}
      initialState={fixtures.createExecRender()}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
      command="tui-stories render CLI/Exec/Running/RunningVerboseParallel --path packages/@overeng/megarepo --output log --final"
    />
  ),
}

/** Rendered mr store status output (wider width) */
export const StoreStatusOutput: Story = {
  render: (args) => (
    <TuiStoryPreview
      View={RenderView}
      app={RenderApp}
      initialState={fixtures.createStoreStatusRender()}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
      command="tui-stories render CLI/Store/Status/MixedIssues --path packages/@overeng/megarepo --output log --width 100"
    />
  ),
}
