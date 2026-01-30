import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import {
  TaskListBasicExample,
  TaskListAllStatesExample,
  TaskListWithSummaryExample,
  SyncSimulationExample,
} from '../examples/mod.ts'
import { TuiStoryPreview } from '../storybook/TuiStoryPreview.tsx'
import { Box } from './Box.tsx'
import { TaskList, type TaskItem } from './TaskList.tsx'
import { Text } from './Text.tsx'

const meta: Meta<typeof TaskList> = {
  title: 'Components/Lists/TaskList',
  component: TaskList,
}

export default meta
type Story = StoryObj<typeof TaskList>

/** Basic task list with mixed states */
export const Basic: Story = {
  render: () => (
    <TuiStoryPreview>
      <TaskListBasicExample />
    </TuiStoryPreview>
  ),
}

/** All possible task states */
export const AllStates: Story = {
  render: () => (
    <TuiStoryPreview>
      <TaskListAllStatesExample />
    </TuiStoryPreview>
  ),
}

export const WithTitle: Story = {
  render: (args) => (
    <TuiStoryPreview>
      <TaskList {...args} />
    </TuiStoryPreview>
  ),
  args: {
    items: [
      { id: '1', label: 'effect-utils', status: 'success' },
      { id: '2', label: 'livestore', status: 'active', message: 'syncing...' },
      { id: '3', label: 'dotfiles', status: 'pending' },
    ],
    title: 'Syncing Repositories',
  },
}

/** Task list with summary showing counts and elapsed time */
export const WithSummary: Story = {
  render: () => (
    <TuiStoryPreview>
      <TaskListWithSummaryExample />
    </TuiStoryPreview>
  ),
}

export const LongList: Story = {
  render: (args) => (
    <TuiStoryPreview>
      <TaskList {...args} />
    </TuiStoryPreview>
  ),
  args: {
    items: Array.from({ length: 15 }, (_, i) => ({
      id: String(i),
      label: `repository-${i + 1}`,
      status: i < 5 ? 'success' : i < 8 ? 'active' : 'pending',
      message: i < 5 ? undefined : i < 8 ? 'syncing...' : undefined,
    })) as TaskItem[],
    title: 'Large Repository Set',
    showSummary: true,
    elapsed: 45000,
  },
}

/** Interactive sync simulation (animated in terminal) */
export const SyncSimulation: Story = {
  render: () => (
    <TuiStoryPreview>
      <SyncSimulationExample />
    </TuiStoryPreview>
  ),
}

export const InContext: Story = {
  render: () => (
    <TuiStoryPreview>
      <Box>
        <Box flexDirection="row">
          <Text bold>mr sync</Text>
          <Text dim> schickling/megarepo-all</Text>
        </Box>
        <Box paddingTop={1}>
          <TaskList
            items={[
              { id: '1', label: 'effect-utils', status: 'success' },
              { id: '2', label: 'livestore', status: 'active', message: 'pulling...' },
              { id: '3', label: 'dotfiles', status: 'pending' },
            ]}
            showSummary
            elapsed={2100}
          />
        </Box>
      </Box>
    </TuiStoryPreview>
  ),
}
