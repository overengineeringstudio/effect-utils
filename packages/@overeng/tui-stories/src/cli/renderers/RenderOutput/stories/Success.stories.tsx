/** Render command success stories — showing rendered story output */

import type { Meta, StoryObj } from '@storybook/react'
import React, { useMemo } from 'react'

import {
  ALL_OUTPUT_TABS,
  commonArgTypes,
  createInteractiveProps,
  defaultStoryArgs,
  TuiStoryPreview,
} from '@overeng/tui-react/storybook'

import { RenderApp } from '../app.ts'
import { RenderView } from '../view.tsx'
import type { RenderFlagConfig } from './_fixtures.ts'
import * as fixtures from './_fixtures.ts'

type StoryArgs = {
  height: number
  interactive: boolean
  playbackSpeed: number
  width: number
  final: boolean
}

export default {
  component: RenderView,
  title: 'tui-stories/Render/Success',
  parameters: { layout: 'fullscreen' },
  args: {
    ...defaultStoryArgs,
    width: 80,
    final: false,
  },
  argTypes: {
    ...commonArgTypes,
    width: {
      description: 'Terminal width in columns (--width flag)',
      control: { type: 'range', min: 40, max: 200, step: 10 },
    },
    final: {
      description: 'Show final timeline state (--final flag)',
      control: { type: 'boolean' },
    },
  },
} satisfies Meta

type Story = StoryObj<StoryArgs>

/** Derives RenderFlagConfig from story args */
const useFlagConfig = (args: StoryArgs): Partial<RenderFlagConfig> =>
  useMemo(
    () => ({
      width: args.width,
      timelineMode: args.final === true ? 'final' : 'initial',
    }),
    [args.width, args.final],
  )

/** Builds the command string shown in the story preview */
const buildCommand = ({ args, storyId }: { args: StoryArgs; storyId: string }): string =>
  `tui-stories render ${storyId} --path packages/@overeng/megarepo --width ${args.width}${args.final === true ? ' --final' : ''}`

/** Rendered mr status output */
const StatusOutputRender = (args: StoryArgs) => {
  const flagConfig = useFlagConfig(args)
  return (
    <TuiStoryPreview
      View={RenderView}
      app={RenderApp}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
      command={buildCommand({ args, storyId: 'CLI/Status/Basic/Default' })}
      {...createInteractiveProps({
        args,
        staticState: fixtures.createStatusRender(flagConfig),
        idleState: fixtures.createRenderingState(flagConfig),
        createTimeline: () => fixtures.createTimeline(flagConfig),
      })}
    />
  )
}

export const StatusOutput: Story = {
  render: (args) => <StatusOutputRender {...args} />,
}

/** Rendered mr exec output (final timeline state) */
const ExecOutputRender = (args: StoryArgs) => {
  const flagConfig = useFlagConfig(args)
  return (
    <TuiStoryPreview
      View={RenderView}
      app={RenderApp}
      initialState={fixtures.createExecRender(flagConfig)}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
      command={buildCommand({ args, storyId: 'CLI/Exec/Running/RunningVerboseParallel' })}
    />
  )
}

export const ExecOutput: Story = {
  args: { final: true },
  render: (args) => <ExecOutputRender {...args} />,
}

/** Rendered mr store status output (wider width) */
const StoreStatusOutputRender = (args: StoryArgs) => {
  const flagConfig = useFlagConfig(args)
  return (
    <TuiStoryPreview
      View={RenderView}
      app={RenderApp}
      initialState={fixtures.createStoreStatusRender(flagConfig)}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
      command={buildCommand({ args, storyId: 'CLI/Store/Status/MixedIssues' })}
    />
  )
}

export const StoreStatusOutput: Story = {
  args: { width: 100 },
  render: (args) => <StoreStatusOutputRender {...args} />,
}
