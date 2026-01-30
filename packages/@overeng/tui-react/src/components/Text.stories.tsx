import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TextColorsExample, TextStylesExample } from '../examples/mod.ts'
import { TuiStoryPreview } from '../storybook/TuiStoryPreview.tsx'
import { Box } from './Box.tsx'
import { Text } from './Text.tsx'

const meta: Meta<typeof Text> = {
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
}

export default meta
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
      <TextColorsExample />
    </TuiStoryPreview>
  ),
}

/** All available text styles */
export const AllStyles: Story = {
  render: () => (
    <TuiStoryPreview>
      <TextStylesExample />
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
