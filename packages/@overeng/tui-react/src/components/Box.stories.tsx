import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'
import { Box } from './Box.tsx'
import { Text } from './Text.tsx'
import { BoxBasicExample, BoxNestedExample, BoxComplexLayoutExample } from '../examples/mod.ts'

const meta: Meta<typeof Box> = {
  title: 'Primitives/Box',
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
  render: () => <BoxBasicExample />,
}

export const Row: Story = {
  render: () => (
    <Box flexDirection="row">
      <Text color="red">[ERROR]</Text>
      <Text> Something went wrong</Text>
    </Box>
  ),
}

export const Column: Story = {
  render: () => (
    <Box flexDirection="column">
      <Text bold>Header</Text>
      <Text>Content line 1</Text>
      <Text>Content line 2</Text>
    </Box>
  ),
}

export const WithPadding: Story = {
  render: () => (
    <Box padding={2}>
      <Text>This text has padding around it</Text>
    </Box>
  ),
}

/** Nested boxes with indentation */
export const Nested: Story = {
  render: () => <BoxNestedExample />,
}

/** Complex CLI-like layout */
export const ComplexLayout: Story = {
  render: () => <BoxComplexLayoutExample />,
}
