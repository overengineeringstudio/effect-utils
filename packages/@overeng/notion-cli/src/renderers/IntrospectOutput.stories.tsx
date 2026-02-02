import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { IntrospectApp } from './IntrospectOutput/mod.ts'
import type { IntrospectState } from './IntrospectOutput/schema.ts'
import { IntrospectView } from './IntrospectOutput/view.tsx'

export default {
  title: 'NotionCLI/Introspect Output',
  component: IntrospectView,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof IntrospectView>

type Story = StoryObj<typeof IntrospectView>

const makeLoadingState = (): IntrospectState => ({
  _tag: 'Loading',
})

const makeErrorState = (message: string): IntrospectState => ({
  _tag: 'Error',
  message,
})

const makeSuccessState = (
  overrides: Partial<Extract<IntrospectState, { _tag: 'Success' }>> = {},
): IntrospectState => ({
  _tag: 'Success',
  dbName: 'My Database',
  dbId: 'abc123-def456',
  dbUrl: 'https://notion.so/abc123def456',
  properties: [],
  ...overrides,
})

export const Loading: Story = {
  render: () => (
    <TuiStoryPreview View={IntrospectView} app={IntrospectApp} initialState={makeLoadingState()} />
  ),
}

export const Success: Story = {
  render: () => (
    <TuiStoryPreview
      View={IntrospectView}
      app={IntrospectApp}
      initialState={makeSuccessState({
        dbName: 'Project Tracker',
        dbId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        dbUrl: 'https://notion.so/a1b2c3d4e5f67890abcdef1234567890',
        properties: [
          { name: 'Name', type: 'title' },
          { name: 'Description', type: 'rich_text' },
          { name: 'Priority', type: 'number' },
          {
            name: 'Status',
            type: 'status',
            groups: ['Not Started', 'In Progress', 'Done'],
          },
          {
            name: 'Category',
            type: 'select',
            options: ['Engineering', 'Design', 'Marketing'],
          },
          {
            name: 'Tags',
            type: 'multi_select',
            options: ['urgent', 'frontend', 'backend', 'bug'],
          },
          { name: 'Done', type: 'checkbox' },
          {
            name: 'Related Tasks',
            type: 'relation',
            relationDatabase: 'Tasks DB',
          },
        ],
      })}
    />
  ),
}

export const WithOptions: Story = {
  render: () => (
    <TuiStoryPreview
      View={IntrospectView}
      app={IntrospectApp}
      initialState={makeSuccessState({
        dbName: 'Options Example',
        dbId: 'opt-12345',
        dbUrl: 'https://notion.so/opt12345',
        properties: [
          { name: 'Name', type: 'title' },
          {
            name: 'Status',
            type: 'select',
            options: ['Active', 'Inactive', 'Pending'],
          },
          {
            name: 'Tags',
            type: 'multi_select',
            options: ['v1', 'v2', 'beta', 'stable', 'deprecated'],
          },
          {
            name: 'Priority',
            type: 'select',
            options: ['Low', 'Medium', 'High', 'Critical'],
          },
        ],
      })}
    />
  ),
}

export const WithRelations: Story = {
  render: () => (
    <TuiStoryPreview
      View={IntrospectView}
      app={IntrospectApp}
      initialState={makeSuccessState({
        dbName: 'Relations Example',
        dbId: 'rel-12345',
        dbUrl: 'https://notion.so/rel12345',
        properties: [
          { name: 'Name', type: 'title' },
          {
            name: 'Assigned To',
            type: 'relation',
            relationDatabase: 'People',
          },
          {
            name: 'Parent Project',
            type: 'relation',
            relationDatabase: 'Projects',
          },
          {
            name: 'Linked Issues',
            type: 'relation',
            relationDatabase: 'Issues Tracker',
          },
        ],
      })}
    />
  ),
}

export const SimpleProperties: Story = {
  render: () => (
    <TuiStoryPreview
      View={IntrospectView}
      app={IntrospectApp}
      initialState={makeSuccessState({
        dbName: 'Simple Database',
        dbId: 'simple-12345',
        dbUrl: 'https://notion.so/simple12345',
        properties: [
          { name: 'Title', type: 'title' },
          { name: 'Notes', type: 'rich_text' },
          { name: 'Count', type: 'number' },
          { name: 'Completed', type: 'checkbox' },
        ],
      })}
    />
  ),
}

export const ErrorState: Story = {
  name: 'Error',
  render: () => (
    <TuiStoryPreview
      View={IntrospectView}
      app={IntrospectApp}
      initialState={makeErrorState('Invalid API key')}
    />
  ),
}
