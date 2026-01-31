import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '../storybook/TuiStoryPreview.tsx'
import { Box } from './Box.tsx'
import { Text } from './Text.tsx'

export default {
  title: 'Components/Typography/Text',
  component: Text,
  argTypes: {
    color: {
      control: 'select',
      options: ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray'],
    },
    bold: { control: 'boolean' },
    dim: { control: 'boolean' },
    italic: { control: 'boolean' },
    underline: { control: 'boolean' },
    strikethrough: { control: 'boolean' },
  },
} satisfies Meta<typeof Text>

type Story = StoryObj<typeof Text>

export const Basic: Story = {
  render: (args) => (
    <TuiStoryPreview>
      <Text {...args}>{args.children ?? 'Hello, World!'}</Text>
    </TuiStoryPreview>
  ),
  args: {
    children: 'Hello, World!',
  },
}

export const WithColor: Story = {
  render: (args) => (
    <TuiStoryPreview>
      <Text {...args}>{args.children ?? 'Success message'}</Text>
    </TuiStoryPreview>
  ),
  args: {
    color: 'green',
    children: 'Success message',
  },
}

export const Bold: Story = {
  render: (args) => (
    <TuiStoryPreview>
      <Text {...args}>{args.children ?? 'Bold text'}</Text>
    </TuiStoryPreview>
  ),
  args: {
    bold: true,
    children: 'Bold text',
  },
}

export const Dim: Story = {
  render: (args) => (
    <TuiStoryPreview>
      <Text {...args}>{args.children ?? 'Dimmed text'}</Text>
    </TuiStoryPreview>
  ),
  args: {
    dim: true,
    children: 'Dimmed text',
  },
}

/** All available text colors */
export const AllColors: Story = {
  render: () => (
    <TuiStoryPreview>
      <Box>
        <Text color="red">Red text</Text>
        <Text color="green">Green text</Text>
        <Text color="yellow">Yellow text</Text>
        <Text color="blue">Blue text</Text>
        <Text color="magenta">Magenta text</Text>
        <Text color="cyan">Cyan text</Text>
        <Text color="white">White text</Text>
        <Text color="gray">Gray text</Text>
      </Box>
    </TuiStoryPreview>
  ),
}

/** All available text styles */
export const AllStyles: Story = {
  render: () => (
    <TuiStoryPreview>
      <Box>
        <Text bold>Bold text</Text>
        <Text dim>Dim text</Text>
        <Text italic>Italic text</Text>
        <Text underline>Underlined text</Text>
        <Text strikethrough>Strikethrough text</Text>
        <Text bold color="cyan">
          Bold + Cyan
        </Text>
      </Box>
    </TuiStoryPreview>
  ),
}

export const Combined: Story = {
  render: () => (
    <TuiStoryPreview>
      <Box flexDirection="row">
        <Text color="green" bold>
          SUCCESS
        </Text>
        <Text dim> - Operation completed</Text>
      </Box>
    </TuiStoryPreview>
  ),
}
