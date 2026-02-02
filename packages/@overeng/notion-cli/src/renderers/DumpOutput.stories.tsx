import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { DumpApp } from './DumpOutput/mod.ts'
import type { DumpAction, DumpState } from './DumpOutput/schema.ts'
import { DumpView } from './DumpOutput/view.tsx'

export default {
  title: 'NotionCLI/Dump Output',
  component: DumpView,
  parameters: { layout: 'padded' },
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
      initialState={createLoadingState()}
      timeline={dumpTimeline}
      autoRun={args.autoRun}
      playbackSpeed={args.playbackSpeed}
      height={args.height}
    />
  ),
}

const createLoadingState = (): DumpState => ({
  _tag: 'Loading',
  databaseId: 'abc123',
})

const createIntrospectingState = (): DumpState => ({
  _tag: 'Introspecting',
  databaseId: 'abc123',
})

const createFetchingState = (pageCount: number): DumpState => ({
  _tag: 'Fetching',
  databaseId: 'abc123',
  dbName: 'Tasks',
  pageCount,
  outputPath: './dump/tasks.json',
})

const createDoneState = (
  overrides: Partial<Extract<DumpState, { _tag: 'Done' }>> = {},
): Extract<DumpState, { _tag: 'Done' }> => ({
  _tag: 'Done',
  pageCount: 150,
  assetsDownloaded: 0,
  assetBytes: 0,
  assetsSkipped: 0,
  failures: 0,
  outputPath: './dump/tasks.json',
  ...overrides,
})

const createErrorState = (): DumpState => ({
  _tag: 'Error',
  message: 'Rate limited by Notion API',
})

export const Loading: Story = {
  render: () => (
    <TuiStoryPreview View={DumpView} app={DumpApp} initialState={createLoadingState()} />
  ),
}

export const Introspecting: Story = {
  render: () => (
    <TuiStoryPreview View={DumpView} app={DumpApp} initialState={createIntrospectingState()} />
  ),
}

export const Fetching: Story = {
  render: () => (
    <TuiStoryPreview View={DumpView} app={DumpApp} initialState={createFetchingState(42)} />
  ),
}

export const FetchingMany: Story = {
  render: () => (
    <TuiStoryPreview View={DumpView} app={DumpApp} initialState={createFetchingState(1500)} />
  ),
}

export const DoneSimple: Story = {
  render: () => <TuiStoryPreview View={DumpView} app={DumpApp} initialState={createDoneState()} />,
}

export const DoneWithAssets: Story = {
  render: () => (
    <TuiStoryPreview
      View={DumpView}
      app={DumpApp}
      initialState={createDoneState({ assetsDownloaded: 25, assetBytes: 15_728_640 })}
    />
  ),
}

export const DoneWithSkippedAssets: Story = {
  render: () => (
    <TuiStoryPreview
      View={DumpView}
      app={DumpApp}
      initialState={createDoneState({ assetsSkipped: 12 })}
    />
  ),
}

export const DoneWithFailures: Story = {
  render: () => (
    <TuiStoryPreview
      View={DumpView}
      app={DumpApp}
      initialState={createDoneState({ failures: 3 })}
    />
  ),
}

export const DoneFullStats: Story = {
  render: () => (
    <TuiStoryPreview
      View={DumpView}
      app={DumpApp}
      initialState={createDoneState({
        assetsDownloaded: 25,
        assetBytes: 15_728_640,
        assetsSkipped: 12,
        failures: 3,
      })}
    />
  ),
}

export const ErrorState: Story = {
  render: () => <TuiStoryPreview View={DumpView} app={DumpApp} initialState={createErrorState()} />,
}
