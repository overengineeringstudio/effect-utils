/**
 * Separator Stories
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { Box, Text } from '@overeng/tui-react'
import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { Separator } from './Separator.tsx'

// =============================================================================
// Meta
// =============================================================================

export default {
  title: 'Components/Separator',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: `
Horizontal separator line.

Default width: 40 characters.
        `,
      },
    },
  },
} satisfies Meta

type Story = StoryObj

// =============================================================================
// Stories
// =============================================================================

export const Default: Story = {
  render: () => (
    <TuiStoryPreview>
      <Separator />
    </TuiStoryPreview>
  ),
}

export const CustomWidth: Story = {
  render: () => (
    <TuiStoryPreview>
      <Box flexDirection="column" gap={1}>
        <Separator width={20} />
        <Separator width={40} />
        <Separator width={60} />
      </Box>
    </TuiStoryPreview>
  ),
}

export const InContext: Story = {
  render: () => (
    <TuiStoryPreview>
      <Box flexDirection="column">
        <Text>Results:</Text>
        <Text> ✓ effect synced</Text>
        <Text> ✓ livestore cloned</Text>
        <Text> </Text>
        <Separator />
        <Text dim>2 synced · 1 cloned</Text>
      </Box>
    </TuiStoryPreview>
  ),
}
