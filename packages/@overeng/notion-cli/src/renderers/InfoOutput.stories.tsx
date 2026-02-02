/**
 * Storybook stories for InfoOutput component.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { InfoApp } from './InfoOutput/mod.ts'
import type { InfoState } from './InfoOutput/schema.ts'
import { InfoView } from './InfoOutput/view.tsx'

// =============================================================================
// State Factories
// =============================================================================

const createLoadingState = (): InfoState => ({
  _tag: 'Loading',
})

const createSuccessState = (): InfoState => ({
  _tag: 'Success',
  dbName: 'Project Tracker',
  dbId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  dbUrl: 'https://www.notion.so/workspace/a1b2c3d4e5f67890abcdef1234567890',
  properties: [
    { name: 'Name', type: 'title' },
    { name: 'Description', type: 'rich_text' },
    { name: 'Priority', type: 'number' },
    { name: 'Status', type: 'select' },
    { name: 'Due Date', type: 'date' },
    { name: 'Completed', type: 'checkbox' },
  ],
  rowCount: '1,234',
})

const createManyPropertiesState = (): InfoState => ({
  _tag: 'Success',
  dbName: 'Content Calendar',
  dbId: 'f1e2d3c4-b5a6-9870-fedc-ba0987654321',
  dbUrl: 'https://www.notion.so/workspace/f1e2d3c4b5a69870fedcba0987654321',
  properties: [
    { name: 'Title', type: 'title' },
    { name: 'Summary', type: 'rich_text' },
    { name: 'Author', type: 'people' },
    { name: 'Category', type: 'select' },
    { name: 'Tags', type: 'multi_select' },
    { name: 'Publish Date', type: 'date' },
    { name: 'Word Count', type: 'number' },
    { name: 'Published', type: 'checkbox' },
    { name: 'Cover Image', type: 'files' },
    { name: 'Source URL', type: 'url' },
    { name: 'Contact Email', type: 'email' },
    { name: 'Phone', type: 'phone_number' },
    { name: 'Related Posts', type: 'relation' },
    { name: 'Views Formula', type: 'formula' },
    { name: 'Created', type: 'created_time' },
    { name: 'Last Edited', type: 'last_edited_time' },
  ],
  rowCount: '8,742',
})

const createSinglePropertyState = (): InfoState => ({
  _tag: 'Success',
  dbName: 'Simple List',
  dbId: '11112222-3333-4444-5555-666677778888',
  dbUrl: 'https://www.notion.so/workspace/11112222333344445555666677778888',
  properties: [{ name: 'Name', type: 'title' }],
  rowCount: '42',
})

const createErrorState = (): InfoState => ({
  _tag: 'Error',
  message: 'Database not found: abc-123',
})

// =============================================================================
// Meta
// =============================================================================

export default {
  title: 'NotionCLI/Info Output',
  component: InfoView,
  parameters: {
    layout: 'padded',
  },
} satisfies Meta<typeof InfoView>

type Story = StoryObj<typeof InfoView>

// =============================================================================
// Stories
// =============================================================================

export const Loading: Story = {
  render: () => (
    <TuiStoryPreview View={InfoView} app={InfoApp} initialState={createLoadingState()} />
  ),
}

export const Success: Story = {
  render: () => (
    <TuiStoryPreview View={InfoView} app={InfoApp} initialState={createSuccessState()} />
  ),
}

export const ManyProperties: Story = {
  render: () => (
    <TuiStoryPreview View={InfoView} app={InfoApp} initialState={createManyPropertiesState()} />
  ),
}

export const SingleProperty: Story = {
  render: () => (
    <TuiStoryPreview View={InfoView} app={InfoApp} initialState={createSinglePropertyState()} />
  ),
}

export const ErrorState: Story = {
  name: 'Error',
  render: () => <TuiStoryPreview View={InfoView} app={InfoApp} initialState={createErrorState()} />,
}
