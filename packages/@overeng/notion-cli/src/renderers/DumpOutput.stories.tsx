import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import * as fixtures from './DumpOutput/_fixtures.ts'
import { DumpApp } from './DumpOutput/mod.ts'
import type { DumpAction } from './DumpOutput/schema.ts'
import { DumpView } from './DumpOutput/view.tsx'

export default {
  title: 'NotionCLI/Dump Output',
  component: DumpView,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof DumpView>

type Story = StoryObj<{ autoRun: boolean; playbackSpeed: number; height: number }>

const dumpTimeline: Array<{ at: number; action: DumpAction }> = [
  { at: 0, action: { _tag: 'SetIntrospecting', databaseId: 'abc-123' } },
  { at: 1000, action: { _tag: 'SetFetching', dbName: 'Tasks', outputPath: './dump/tasks.json' } },
  { at: 1800, action: { _tag: 'AddPages', count: 25 } },
  { at: 2400, action: { _tag: 'AddPages', count: 25 } },
  { at: 3000, action: { _tag: 'AddPages', count: 25 } },
  { at: 3600, action: { _tag: 'AddPages', count: 25 } },
  { at: 4200, action: { _tag: 'AddPages', count: 25 } },
  { at: 4800, action: { _tag: 'AddPages', count: 17 } },
  {
    at: 5500,
    action: {
      _tag: 'SetDone',
      assetsDownloaded: 8,
      assetBytes: 4_194_304,
      assetsSkipped: 3,
      failures: 0,
    },
  },
]

export const Demo: Story = {
  args: { autoRun: true, playbackSpeed: 1, height: 300 },
  argTypes: {
    autoRun: { control: { type: 'boolean' } },
    playbackSpeed: { control: { type: 'range', min: 0.5, max: 3, step: 0.5 } },
    height: { control: { type: 'range', min: 200, max: 600, step: 50 } },
  },
  render: (args) => (
    <TuiStoryPreview
      View={DumpView}
      app={DumpApp}
      initialState={fixtures.createLoadingState()}
      timeline={dumpTimeline}
      autoRun={args.autoRun}
      playbackSpeed={args.playbackSpeed}
      height={args.height}
    />
  ),
}

export const Loading: Story = {
  render: () => (
    <TuiStoryPreview View={DumpView} app={DumpApp} initialState={fixtures.createLoadingState()} autoRun={false} />
  ),
}

export const Introspecting: Story = {
  render: () => (
    <TuiStoryPreview View={DumpView} app={DumpApp} initialState={fixtures.createIntrospectingState()} autoRun={false} />
  ),
}

export const Fetching: Story = {
  render: () => (
    <TuiStoryPreview View={DumpView} app={DumpApp} initialState={fixtures.createFetchingState(42)} autoRun={false} />
  ),
}

export const FetchingMany: Story = {
  render: () => (
    <TuiStoryPreview View={DumpView} app={DumpApp} initialState={fixtures.createFetchingState(1500)} autoRun={false} />
  ),
}

export const DoneSimple: Story = {
  render: () => <TuiStoryPreview View={DumpView} app={DumpApp} initialState={fixtures.createDoneState()} autoRun={false} />,
}

export const DoneWithAssets: Story = {
  render: () => (
    <TuiStoryPreview
      View={DumpView}
      app={DumpApp}
      initialState={fixtures.createDoneState({ assetsDownloaded: 25, assetBytes: 15_728_640 })}
      autoRun={false}
    />
  ),
}

export const DoneWithSkippedAssets: Story = {
  render: () => (
    <TuiStoryPreview
      View={DumpView}
      app={DumpApp}
      initialState={fixtures.createDoneState({ assetsSkipped: 12 })}
      autoRun={false}
    />
  ),
}

export const DoneWithFailures: Story = {
  render: () => (
    <TuiStoryPreview
      View={DumpView}
      app={DumpApp}
      initialState={fixtures.createDoneState({ failures: 3 })}
      autoRun={false}
    />
  ),
}

export const DoneFullStats: Story = {
  render: () => (
    <TuiStoryPreview
      View={DumpView}
      app={DumpApp}
      initialState={fixtures.createDoneState({
        assetsDownloaded: 25,
        assetBytes: 15_728_640,
        assetsSkipped: 12,
        failures: 3,
      })}
      autoRun={false}
    />
  ),
}

export const ErrorState: Story = {
  render: () => <TuiStoryPreview View={DumpView} app={DumpApp} initialState={fixtures.createErrorState()} autoRun={false} />,
}
