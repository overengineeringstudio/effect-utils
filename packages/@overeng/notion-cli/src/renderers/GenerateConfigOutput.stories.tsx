import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { GenerateConfigApp } from './GenerateConfigOutput/mod.ts'
import type { GenerateConfigAction, GenerateConfigState } from './GenerateConfigOutput/schema.ts'
import { GenerateConfigView } from './GenerateConfigOutput/view.tsx'

export default {
  title: 'NotionCLI/Generate Config Output',
  component: GenerateConfigView,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof GenerateConfigView>

type Story = StoryObj<{ autoRun: boolean; playbackSpeed: number; height: number }>

const generateConfigTimeline: Array<{ at: number; action: GenerateConfigAction }> = [
  {
    at: 0,
    action: {
      _tag: 'SetConfig',
      configPath: './notion.config.ts',
      databases: [
        { id: 'db-tasks', name: 'Tasks', outputPath: './src/generated/tasks.ts' },
        { id: 'db-projects', name: 'Projects', outputPath: './src/generated/projects.ts' },
        { id: 'db-people', name: 'People', outputPath: './src/generated/people.ts' },
        {
          id: 'db-sprint',
          name: 'Sprint Backlog',
          outputPath: './src/generated/sprint-backlog.ts',
        },
      ],
    },
  },
  { at: 800, action: { _tag: 'UpdateDatabase', id: 'db-tasks', status: 'introspecting' } },
  { at: 1200, action: { _tag: 'UpdateDatabase', id: 'db-projects', status: 'introspecting' } },
  { at: 1800, action: { _tag: 'UpdateDatabase', id: 'db-tasks', status: 'generating' } },
  { at: 2200, action: { _tag: 'UpdateDatabase', id: 'db-people', status: 'introspecting' } },
  { at: 2500, action: { _tag: 'UpdateDatabase', id: 'db-tasks', status: 'writing' } },
  { at: 2800, action: { _tag: 'UpdateDatabase', id: 'db-projects', status: 'generating' } },
  { at: 3000, action: { _tag: 'UpdateDatabase', id: 'db-tasks', status: 'done' } },
  { at: 3200, action: { _tag: 'UpdateDatabase', id: 'db-sprint', status: 'introspecting' } },
  { at: 3500, action: { _tag: 'UpdateDatabase', id: 'db-projects', status: 'writing' } },
  { at: 3800, action: { _tag: 'UpdateDatabase', id: 'db-people', status: 'generating' } },
  { at: 4000, action: { _tag: 'UpdateDatabase', id: 'db-projects', status: 'done' } },
  { at: 4300, action: { _tag: 'UpdateDatabase', id: 'db-people', status: 'writing' } },
  { at: 4500, action: { _tag: 'UpdateDatabase', id: 'db-sprint', status: 'generating' } },
  { at: 4800, action: { _tag: 'UpdateDatabase', id: 'db-people', status: 'done' } },
  { at: 5200, action: { _tag: 'UpdateDatabase', id: 'db-sprint', status: 'writing' } },
  { at: 5500, action: { _tag: 'UpdateDatabase', id: 'db-sprint', status: 'done' } },
  { at: 6000, action: { _tag: 'SetDone', count: 4 } },
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
      View={GenerateConfigView}
      app={GenerateConfigApp}
      initialState={{ _tag: 'Loading', configPath: './notion.config.ts' } as GenerateConfigState}
      timeline={generateConfigTimeline}
      autoRun={args.autoRun}
      playbackSpeed={args.playbackSpeed}
      height={args.height}
    />
  ),
}

const makeLoading = (configPath: string): GenerateConfigState => ({
  _tag: 'Loading',
  configPath,
})

const makeRunning = ({
  configPath,
  databases,
}: {
  configPath: string
  databases: Array<{
    id: string
    name: string
    status: 'pending' | 'introspecting' | 'generating' | 'writing' | 'done' | 'error'
    outputPath?: string
  }>
}): GenerateConfigState => ({
  _tag: 'Running',
  configPath,
  databases,
})

const makeDone = ({ configPath, count }: { configPath: string; count: number }): GenerateConfigState => ({
  _tag: 'Done',
  configPath,
  count,
})

const makeError = (message: string): GenerateConfigState => ({
  _tag: 'Error',
  message,
})

const makeDatabase = ({
  name,
  status,
  outputPath,
}: {
  name: string
  status: 'pending' | 'introspecting' | 'generating' | 'writing' | 'done' | 'error'
  outputPath?: string
}) => ({
  id: `db-${name.toLowerCase().replace(/\s+/g, '-')}`,
  name,
  status,
  ...(outputPath !== undefined ? { outputPath } : {}),
})

export const Loading: Story = {
  render: () => (
    <TuiStoryPreview
      View={GenerateConfigView}
      app={GenerateConfigApp}
      initialState={makeLoading('./notion.config.ts')}
    />
  ),
}

export const AllPending: Story = {
  render: () => (
    <TuiStoryPreview
      View={GenerateConfigView}
      app={GenerateConfigApp}
      initialState={makeRunning({ configPath: './notion.config.ts', databases: [
        makeDatabase({ name: 'Tasks', status: 'pending' }),
        makeDatabase({ name: 'Projects', status: 'pending' }),
        makeDatabase({ name: 'People', status: 'pending' }),
        makeDatabase({ name: 'Sprint Backlog', status: 'pending' }),
      ] })}
    />
  ),
}

export const InProgress: Story = {
  render: () => (
    <TuiStoryPreview
      View={GenerateConfigView}
      app={GenerateConfigApp}
      initialState={makeRunning({ configPath: './notion.config.ts', databases: [
        makeDatabase({ name: 'Tasks', status: 'done', outputPath: './src/generated/tasks.ts' }),
        makeDatabase({ name: 'Projects', status: 'generating' }),
        makeDatabase({ name: 'People', status: 'introspecting' }),
        makeDatabase({ name: 'Sprint Backlog', status: 'pending' }),
      ] })}
    />
  ),
}

export const AllDone: Story = {
  render: () => (
    <TuiStoryPreview
      View={GenerateConfigView}
      app={GenerateConfigApp}
      initialState={makeDone({ configPath: './notion.config.ts', count: 4 })}
    />
  ),
}

export const WithErrors: Story = {
  render: () => (
    <TuiStoryPreview
      View={GenerateConfigView}
      app={GenerateConfigApp}
      initialState={makeRunning({ configPath: './notion.config.ts', databases: [
        makeDatabase({ name: 'Tasks', status: 'done', outputPath: './src/generated/tasks.ts' }),
        makeDatabase({ name: 'Projects', status: 'error' }),
        makeDatabase({ name: 'People', status: 'done', outputPath: './src/generated/people.ts' }),
        makeDatabase({ name: 'Sprint Backlog', status: 'error' }),
      ] })}
    />
  ),
}

export const SingleDatabase: Story = {
  render: () => (
    <TuiStoryPreview
      View={GenerateConfigView}
      app={GenerateConfigApp}
      initialState={makeRunning({ configPath: './notion.config.ts', databases: [makeDatabase({ name: 'Tasks', status: 'generating' })] })}
    />
  ),
}

export const ManyDatabases: Story = {
  render: () => (
    <TuiStoryPreview
      View={GenerateConfigView}
      app={GenerateConfigApp}
      initialState={makeRunning({ configPath: './notion.config.ts', databases: [
        makeDatabase({ name: 'Tasks', status: 'done', outputPath: './src/generated/tasks.ts' }),
        makeDatabase({ name: 'Projects', status: 'done', outputPath: './src/generated/projects.ts' }),
        makeDatabase({ name: 'People', status: 'writing' }),
        makeDatabase({ name: 'Sprint Backlog', status: 'generating' }),
        makeDatabase({ name: 'Meeting Notes', status: 'introspecting' }),
        makeDatabase({ name: 'Knowledge Base', status: 'pending' }),
        makeDatabase({ name: 'Bug Tracker', status: 'pending' }),
        makeDatabase({ name: 'Release Notes', status: 'error' }),
      ] })}
    />
  ),
}

export const ErrorState: Story = {
  render: () => (
    <TuiStoryPreview
      View={GenerateConfigView}
      app={GenerateConfigApp}
      initialState={makeError('Config file not found: ./notion.config.ts')}
    />
  ),
}
