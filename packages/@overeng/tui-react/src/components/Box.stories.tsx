import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '../storybook/TuiStoryPreview.tsx'
import { Box } from './Box.tsx'
import { Text } from './Text.tsx'

const meta: Meta<typeof Box> = {
  title: 'Components/Layout/Box',
  component: Box,
  argTypes: {
    flexDirection: {
      control: 'select',
      options: ['row', 'column', 'row-reverse', 'column-reverse'],
    },
    padding: { control: 'number' },
    paddingTop: { control: 'number' },
    paddingBottom: { control: 'number' },
    paddingLeft: { control: 'number' },
    paddingRight: { control: 'number' },
    gap: { control: 'number' },
  },
}

export default meta
type Story = StoryObj<typeof Box>

/** Basic vertical layout */
export const Basic: Story = {
  render: () => (
    <TuiStoryPreview>
      <Box>
        <Text>Line 1</Text>
        <Text>Line 2</Text>
        <Text>Line 3</Text>
      </Box>
    </TuiStoryPreview>
  ),
}

export const Row: Story = {
  render: () => (
    <TuiStoryPreview>
      <Box flexDirection="row">
        <Text color="red">[ERROR]</Text>
        <Text> Something went wrong</Text>
      </Box>
    </TuiStoryPreview>
  ),
}

export const Column: Story = {
  render: () => (
    <TuiStoryPreview>
      <Box flexDirection="column">
        <Text bold>Header</Text>
        <Text>Content line 1</Text>
        <Text>Content line 2</Text>
      </Box>
    </TuiStoryPreview>
  ),
}

export const WithPadding: Story = {
  render: () => (
    <TuiStoryPreview>
      <Box padding={2}>
        <Text>This text has padding around it</Text>
      </Box>
    </TuiStoryPreview>
  ),
}

/** Nested boxes with indentation */
export const Nested: Story = {
  render: () => (
    <TuiStoryPreview>
      <Box>
        <Text bold>Tasks</Text>
        <Box paddingLeft={2}>
          <Text color="green">Task 1 - Done</Text>
          <Text color="yellow">Task 2 - In Progress</Text>
          <Text dim>Task 3 - Pending</Text>
        </Box>
      </Box>
    </TuiStoryPreview>
  ),
}

/** Complex CLI-like layout */
export const ComplexLayout: Story = {
  render: () => (
    <TuiStoryPreview>
      <Box>
        <Box flexDirection="row">
          <Text bold>mr sync</Text>
          <Text dim> workspace/project</Text>
        </Box>
        <Text> </Text>
        <Box paddingLeft={2}>
          <Box flexDirection="row">
            <Text color="green">OK</Text>
            <Text> member-1</Text>
          </Box>
          <Box flexDirection="row">
            <Text color="green">OK</Text>
            <Text> member-2</Text>
          </Box>
          <Box flexDirection="row">
            <Text color="red">ERR</Text>
            <Text> member-3</Text>
            <Text dim> (network error)</Text>
          </Box>
        </Box>
      </Box>
    </TuiStoryPreview>
  ),
}
