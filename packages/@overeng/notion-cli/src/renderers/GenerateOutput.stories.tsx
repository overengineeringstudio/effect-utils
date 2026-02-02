import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { GenerateApp } from './GenerateOutput/mod.ts'
import type { GenerateAction, GenerateState } from './GenerateOutput/schema.ts'
import { GenerateView } from './GenerateOutput/view.tsx'

export default {
  title: 'NotionCLI/Generate Output',
  component: GenerateView,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof GenerateView>

type Story = StoryObj<{ autoRun: boolean; playbackSpeed: number; height: number }>

const generateTimeline: Array<{ at: number; action: GenerateAction }> = [
  { at: 0, action: { _tag: 'SetIntrospecting', databaseId: 'abc-123-def-456' } },
  { at: 1500, action: { _tag: 'SetGenerating', schemaName: 'TasksDB' } },
  { at: 2500, action: { _tag: 'SetWriting', outputPath: './src/generated/tasks.ts' } },
  { at: 3500, action: { _tag: 'SetDone', outputPath: './src/generated/tasks.ts', writable: true } },
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
      View={GenerateView}
      app={GenerateApp}
      initialState={createIntrospectingState()}
      timeline={generateTimeline}
      autoRun={args.autoRun}
      playbackSpeed={args.playbackSpeed}
      height={args.height}
    />
  ),
}

const createIntrospectingState = (): GenerateState => ({
  _tag: 'Introspecting',
  databaseId: 'abc123def456',
})

const createGeneratingState = (): GenerateState => ({
  _tag: 'Generating',
  schemaName: 'TasksDB',
})

const createWritingState = (): GenerateState => ({
  _tag: 'Writing',
  outputPath: './src/generated/tasks.ts',
})

const createDoneState = (): GenerateState => ({
  _tag: 'Done',
  outputPath: './src/generated/tasks.ts',
  writable: true,
})

const createDoneReadOnlyState = (): GenerateState => ({
  _tag: 'Done',
  outputPath: './src/generated/tasks.ts',
  writable: false,
})

const createDoneWithApiState = (): GenerateState => ({
  _tag: 'Done',
  outputPath: './src/generated/tasks.ts',
  writable: true,
  apiOutputPath: './src/generated/tasks.api.ts',
})

const createDryRunState = (): GenerateState => ({
  _tag: 'DryRun',
  code: `import { Schema } from "@effect/schema"

export const TasksDB = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: Schema.Literal("todo", "in-progress", "done"),
  priority: Schema.optional(Schema.Number),
  assignee: Schema.optional(Schema.String),
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
})

export type TasksDB = Schema.Schema.Type<typeof TasksDB>`,
  outputPath: './src/generated/tasks.ts',
})

const createDryRunWithApiState = (): GenerateState => ({
  _tag: 'DryRun',
  code: `import { Schema } from "@effect/schema"

export const TasksDB = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  status: Schema.Literal("todo", "in-progress", "done"),
  priority: Schema.optional(Schema.Number),
  createdAt: Schema.Date,
})

export type TasksDB = Schema.Schema.Type<typeof TasksDB>`,
  apiCode: `import { TasksDB } from "./tasks.ts"
import { NotionApi } from "@overeng/notion-client"

export const tasksApi = NotionApi.makeDatabaseApi({
  schema: TasksDB,
  databaseId: "abc123def456",
})`,
  outputPath: './src/generated/tasks.ts',
  apiOutputPath: './src/generated/tasks.api.ts',
})

const createErrorState = (): GenerateState => ({
  _tag: 'Error',
  message: 'Failed to introspect database: 401 Unauthorized',
})

export const Introspecting: Story = {
  render: () => (
    <TuiStoryPreview
      View={GenerateView}
      app={GenerateApp}
      initialState={createIntrospectingState()}
    />
  ),
}

export const Generating: Story = {
  render: () => (
    <TuiStoryPreview View={GenerateView} app={GenerateApp} initialState={createGeneratingState()} />
  ),
}

export const Writing: Story = {
  render: () => (
    <TuiStoryPreview View={GenerateView} app={GenerateApp} initialState={createWritingState()} />
  ),
}

export const Done: Story = {
  render: () => (
    <TuiStoryPreview View={GenerateView} app={GenerateApp} initialState={createDoneState()} />
  ),
}

export const DoneReadOnly: Story = {
  render: () => (
    <TuiStoryPreview
      View={GenerateView}
      app={GenerateApp}
      initialState={createDoneReadOnlyState()}
    />
  ),
}

export const DoneWithApi: Story = {
  render: () => (
    <TuiStoryPreview
      View={GenerateView}
      app={GenerateApp}
      initialState={createDoneWithApiState()}
    />
  ),
}

export const DryRun: Story = {
  render: () => (
    <TuiStoryPreview View={GenerateView} app={GenerateApp} initialState={createDryRunState()} />
  ),
}

export const DryRunWithApi: Story = {
  render: () => (
    <TuiStoryPreview
      View={GenerateView}
      app={GenerateApp}
      initialState={createDryRunWithApiState()}
    />
  ),
}

export const ErrorState: Story = {
  render: () => (
    <TuiStoryPreview View={GenerateView} app={GenerateApp} initialState={createErrorState()} />
  ),
}
