/**
 * StatusIcon Stories
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { Box, Text } from '@overeng/tui-react'
import { createStaticApp, TuiStoryPreview } from '@overeng/tui-react/storybook'

const StaticApp = createStaticApp()

import { StatusIcon } from './StatusIcon.tsx'

// =============================================================================
// Helper View
// =============================================================================

const StatusIconShowcase = () => (
  <Box flexDirection="column" gap={1}>
    <Text bold>Task Statuses:</Text>
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <StatusIcon status="pending" />
        <Text>pending</Text>
      </Box>
      <Box flexDirection="row" gap={1}>
        <StatusIcon status="active" />
        <Text>active (spinner)</Text>
      </Box>
      <Box flexDirection="row" gap={1}>
        <StatusIcon status="success" />
        <Text>success</Text>
      </Box>
      <Box flexDirection="row" gap={1}>
        <StatusIcon status="error" />
        <Text>error</Text>
      </Box>
      <Box flexDirection="row" gap={1}>
        <StatusIcon status="skipped" />
        <Text>skipped</Text>
      </Box>
    </Box>

    <Text> </Text>
    <Text bold>Sync Result Statuses:</Text>
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        <StatusIcon status="cloned" variant="sync" />
        <Text>cloned</Text>
      </Box>
      <Box flexDirection="row" gap={1}>
        <StatusIcon status="synced" variant="sync" />
        <Text>synced</Text>
      </Box>
      <Box flexDirection="row" gap={1}>
        <StatusIcon status="updated" variant="sync" />
        <Text>updated</Text>
      </Box>
      <Box flexDirection="row" gap={1}>
        <StatusIcon status="locked" variant="sync" />
        <Text>locked</Text>
      </Box>
      <Box flexDirection="row" gap={1}>
        <StatusIcon status="already_synced" variant="sync" />
        <Text>already_synced</Text>
      </Box>
      <Box flexDirection="row" gap={1}>
        <StatusIcon status="skipped" variant="sync" />
        <Text>skipped</Text>
      </Box>
      <Box flexDirection="row" gap={1}>
        <StatusIcon status="error" variant="sync" />
        <Text>error</Text>
      </Box>
      <Box flexDirection="row" gap={1}>
        <StatusIcon status="removed" variant="sync" />
        <Text>removed</Text>
      </Box>
    </Box>
  </Box>
)

// =============================================================================
// Meta
// =============================================================================

export default {
  title: 'Components/StatusIcon',
  component: StatusIcon,
  render: () => (
    <TuiStoryPreview app={StaticApp} View={() => <StatusIconShowcase />} initialState={null} />
  ),
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: `
Status indicator icons for task and sync states.

**Task statuses:** pending, active, success, error, skipped
**Sync statuses:** cloned, synced, updated, locked, already_synced, skipped, error, removed
        `,
      },
    },
  },
} satisfies Meta<typeof StatusIcon>

type Story = StoryObj<typeof StatusIcon>

// =============================================================================
// Stories
// =============================================================================

export const AllStatuses: Story = {}

export const ActiveSpinner: Story = {
  render: () => (
    <TuiStoryPreview app={StaticApp} View={() => (
      <Box flexDirection="row" gap={1}>
        <StatusIcon status="active" />
        <Text>Syncing...</Text>
      </Box>
    )} initialState={null} />
  ),
}

export const SuccessCheck: Story = {
  render: () => (
    <TuiStoryPreview app={StaticApp} View={() => (
      <Box flexDirection="row" gap={1}>
        <StatusIcon status="success" />
        <Text>Completed</Text>
      </Box>
    )} initialState={null} />
  ),
}

export const ErrorCross: Story = {
  render: () => (
    <TuiStoryPreview app={StaticApp} View={() => (
      <Box flexDirection="row" gap={1}>
        <StatusIcon status="error" />
        <Text>Failed</Text>
      </Box>
    )} initialState={null} />
  ),
}
