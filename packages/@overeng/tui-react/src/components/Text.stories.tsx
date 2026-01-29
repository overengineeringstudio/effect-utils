import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TextColorsExample, TextStylesExample } from '../examples/mod.ts'
import { Box } from './Box.tsx'
import { Text } from './Text.tsx'

const meta: Meta<typeof Text> = {
  title: 'Primitives/Text',
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
  args: {
    children: 'Hello, World!',
  },
}

export const WithColor: Story = {
  args: {
    color: 'green',
    children: 'Success message',
  },
}

export const Bold: Story = {
  args: {
    bold: true,
    children: 'Bold text',
  },
}

export const Dim: Story = {
  args: {
    dim: true,
    children: 'Dimmed text',
  },
}

/** All available text colors */
export const AllColors: Story = {
  render: () => <TextColorsExample />,
}

/** All available text styles */
export const AllStyles: Story = {
  render: () => <TextStylesExample />,
}

export const Combined: Story = {
  render: () => (
    <Box flexDirection="row">
      <Text color="green" bold>
        SUCCESS
      </Text>
      <Text dim> - Operation completed</Text>
    </Box>
  ),
}
