/**
 * Summary Stories
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { Box, Text } from '@overeng/tui-react'
import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { Summary } from './Summary.tsx'

// =============================================================================
// Meta
// =============================================================================

export default {
  title: 'Components/Summary',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: `
Result counts summary line.

Renders dot-separated counts:
\`3 cloned · 2 synced · 1 error\`
        `,
      },
    },
  },
} satisfies Meta

type Story = StoryObj

// =============================================================================
// Stories
// =============================================================================

export const MixedResults: Story = {
  render: () => (
    <TuiStoryPreview>
      <Summary counts={{ cloned: 3, synced: 2, updated: 1, errors: 1 }} />
    </TuiStoryPreview>
  ),
}

export const AllSuccess: Story = {
  render: () => (
    <TuiStoryPreview>
      <Summary counts={{ synced: 5 }} />
    </TuiStoryPreview>
  ),
}

export const WithErrors: Story = {
  render: () => (
    <TuiStoryPreview>
      <Summary counts={{ synced: 3, errors: 2 }} />
    </TuiStoryPreview>
  ),
}

export const AlreadySynced: Story = {
  render: () => (
    <TuiStoryPreview>
      <Summary counts={{ alreadySynced: 5 }} />
    </TuiStoryPreview>
  ),
}

export const NoChanges: Story = {
  render: () => (
    <TuiStoryPreview>
      <Summary counts={{}} />
    </TuiStoryPreview>
  ),
}

export const DryRunMode: Story = {
  render: () => (
    <TuiStoryPreview>
      <Box flexDirection="column" gap={1}>
        <Text bold>Dry run summary:</Text>
        <Summary counts={{ cloned: 3, synced: 2, updated: 1 }} dryRun />
      </Box>
    </TuiStoryPreview>
  ),
}

export const FullExample: Story = {
  render: () => (
    <TuiStoryPreview>
      <Summary
        counts={{
          cloned: 2,
          synced: 3,
          updated: 1,
          locked: 1,
          errors: 1,
          alreadySynced: 2,
        }}
      />
    </TuiStoryPreview>
  ),
}
