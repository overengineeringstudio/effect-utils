import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { BoxBasicExample, BoxNestedExample, BoxComplexLayoutExample } from '../examples/mod.ts'
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
      <BoxBasicExample />
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
      <BoxNestedExample />
    </TuiStoryPreview>
  ),
}

/** Complex CLI-like layout */
export const ComplexLayout: Story = {
  render: () => (
    <TuiStoryPreview>
      <BoxComplexLayoutExample />
    </TuiStoryPreview>
  ),
}
