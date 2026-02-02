import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { DiffApp } from './DiffOutput/mod.ts'
import type { DiffState } from './DiffOutput/schema.ts'
import { DiffView } from './DiffOutput/view.tsx'

export default {
  title: 'NotionCLI/Diff Output',
  component: DiffView,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof DiffView>

type Story = StoryObj<typeof DiffView>

const makeLoadingState = (): DiffState => ({
  _tag: 'Loading',
})

const makeErrorState = (message: string): DiffState => ({
  _tag: 'Error',
  message,
})

const makeNoDifferencesState = (
  overrides: Partial<Extract<DiffState, { _tag: 'NoDifferences' }>> = {},
): DiffState => ({
  _tag: 'NoDifferences',
  databaseId: 'abc123-def456',
  filePath: './schema.ts',
  ...overrides,
})

const makeSuccessState = (
  overrides: Partial<Extract<DiffState, { _tag: 'Success' }>> = {},
): DiffState => ({
  _tag: 'Success',
  databaseId: 'abc123-def456',
  filePath: './schema.ts',
  properties: [],
  options: [],
  hasDifferences: true,
  ...overrides,
})

export const Loading: Story = {
  render: () => <TuiStoryPreview View={DiffView} app={DiffApp} initialState={makeLoadingState()} />,
}

export const NoDifferences: Story = {
  render: () => (
    <TuiStoryPreview
      View={DiffView}
      app={DiffApp}
      initialState={makeNoDifferencesState({
        databaseId: 'project-tracker-db',
        filePath: './src/notion/schema.ts',
      })}
    />
  ),
}

export const WithAddedProperties: Story = {
  render: () => (
    <TuiStoryPreview
      View={DiffView}
      app={DiffApp}
      initialState={makeSuccessState({
        databaseId: 'project-tracker-db',
        filePath: './src/notion/schema.ts',
        properties: [
          { name: 'Due Date', type: 'added', liveType: 'date', liveTransform: 'DateTransform' },
          { name: 'Assignee', type: 'added', liveType: 'people', liveTransform: 'PeopleTransform' },
        ],
      })}
    />
  ),
}

export const WithRemovedProperties: Story = {
  render: () => (
    <TuiStoryPreview
      View={DiffView}
      app={DiffApp}
      initialState={makeSuccessState({
        databaseId: 'project-tracker-db',
        filePath: './src/notion/schema.ts',
        properties: [
          { name: 'Legacy Status', type: 'removed', generatedTransformKey: 'SelectTransform' },
          { name: 'Old Priority', type: 'removed', generatedTransformKey: 'NumberTransform' },
        ],
      })}
    />
  ),
}

export const WithTypeChanges: Story = {
  render: () => (
    <TuiStoryPreview
      View={DiffView}
      app={DiffApp}
      initialState={makeSuccessState({
        databaseId: 'project-tracker-db',
        filePath: './src/notion/schema.ts',
        properties: [
          {
            name: 'Status',
            type: 'type_changed',
            generatedTransformKey: 'SelectTransform',
            liveTransform: 'StatusTransform',
          },
          {
            name: 'Priority',
            type: 'type_changed',
            generatedTransformKey: 'NumberTransform',
            liveTransform: 'SelectTransform',
          },
        ],
      })}
    />
  ),
}

export const MixedChanges: Story = {
  render: () => (
    <TuiStoryPreview
      View={DiffView}
      app={DiffApp}
      initialState={makeSuccessState({
        databaseId: 'project-tracker-db',
        filePath: './src/notion/schema.ts',
        properties: [
          {
            name: 'Tags',
            type: 'added',
            liveType: 'multi_select',
            liveTransform: 'MultiSelectTransform',
          },
          { name: 'Description', type: 'removed', generatedTransformKey: 'RichTextTransform' },
          {
            name: 'Status',
            type: 'type_changed',
            generatedTransformKey: 'SelectTransform',
            liveTransform: 'StatusTransform',
          },
          { name: 'Due Date', type: 'added', liveType: 'date', liveTransform: 'DateTransform' },
        ],
      })}
    />
  ),
}

export const WithOptionsChanges: Story = {
  render: () => (
    <TuiStoryPreview
      View={DiffView}
      app={DiffApp}
      initialState={makeSuccessState({
        databaseId: 'project-tracker-db',
        filePath: './src/notion/schema.ts',
        properties: [],
        options: [
          { name: 'Status', added: ['In Review', 'Blocked'], removed: ['On Hold'] },
          { name: 'Priority', added: ['Critical'], removed: ['Trivial', 'Minor'] },
        ],
      })}
    />
  ),
}

export const FullDiff: Story = {
  render: () => (
    <TuiStoryPreview
      View={DiffView}
      app={DiffApp}
      initialState={makeSuccessState({
        databaseId: 'project-tracker-db',
        filePath: './src/notion/schema.ts',
        properties: [
          { name: 'Assignee', type: 'added', liveType: 'people', liveTransform: 'PeopleTransform' },
          { name: 'Legacy Field', type: 'removed', generatedTransformKey: 'RichTextTransform' },
          {
            name: 'Priority',
            type: 'type_changed',
            generatedTransformKey: 'NumberTransform',
            liveTransform: 'SelectTransform',
          },
        ],
        options: [
          { name: 'Status', added: ['In Review'], removed: ['Archived'] },
          { name: 'Tags', added: ['backend', 'infrastructure'], removed: [] },
        ],
      })}
    />
  ),
}

export const ErrorState: Story = {
  name: 'Error',
  render: () => (
    <TuiStoryPreview
      View={DiffView}
      app={DiffApp}
      initialState={makeErrorState('Schema file not found: ./schema.ts')}
    />
  ),
}
