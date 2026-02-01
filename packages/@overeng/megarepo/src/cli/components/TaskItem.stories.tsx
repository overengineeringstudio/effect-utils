/**
 * TaskItem Stories
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { Box } from '@overeng/tui-react'
import { createStaticApp, TuiStoryPreview } from '@overeng/tui-react/storybook'

const StaticApp = createStaticApp()

import { TaskItem } from './TaskItem.tsx'

// =============================================================================
// Meta
// =============================================================================

export default {
  title: 'Components/TaskItem',
  component: TaskItem,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: `
Single task row with status icon, label, and optional message.

**Visual states:**
- Pending: dim circle, dim label
- Active: spinning dots, bold label
- Success: green check, bold label
- Error: red cross, bold label
- Skipped: yellow circle, dim label
        `,
      },
    },
  },
} satisfies Meta<typeof TaskItem>

type Story = StoryObj<typeof TaskItem>

// =============================================================================
// Stories
// =============================================================================

export const AllStates: Story = {
  render: () => (
    <TuiStoryPreview app={StaticApp} View={() => (
      <Box flexDirection="column">
        <TaskItem id="1" label="effect" status="success" message="synced (main)" />
        <TaskItem id="2" label="effect-utils" status="success" message="updated → abc1234" />
        <TaskItem id="3" label="livestore" status="active" message="syncing..." />
        <TaskItem id="4" label="dotfiles" status="pending" />
        <TaskItem id="5" label="schickling.dev" status="pending" />
      </Box>
    )} initialState={null} />
  ),
}

export const WithErrors: Story = {
  render: () => (
    <TuiStoryPreview app={StaticApp} View={() => (
      <Box flexDirection="column">
        <TaskItem id="1" label="effect" status="success" message="synced (main)" />
        <TaskItem id="2" label="effect-utils" status="error" message="network timeout" />
        <TaskItem id="3" label="livestore" status="success" message="synced (main)" />
        <TaskItem id="4" label="dotfiles" status="skipped" message="dirty worktree" />
        <TaskItem id="5" label="schickling.dev" status="error" message="auth failed" />
      </Box>
    )} initialState={null} />
  ),
}

export const AllPending: Story = {
  render: () => (
    <TuiStoryPreview app={StaticApp} View={() => (
      <Box flexDirection="column">
        <TaskItem id="1" label="effect" status="pending" />
        <TaskItem id="2" label="effect-utils" status="pending" />
        <TaskItem id="3" label="livestore" status="pending" />
        <TaskItem id="4" label="dotfiles" status="pending" />
        <TaskItem id="5" label="schickling.dev" status="pending" />
      </Box>
    )} initialState={null} />
  ),
}

export const AllSuccess: Story = {
  render: () => (
    <TuiStoryPreview app={StaticApp} View={() => (
      <Box flexDirection="column">
        <TaskItem id="1" label="effect" status="success" message="synced (main)" />
        <TaskItem id="2" label="effect-utils" status="success" message="cloned (main)" />
        <TaskItem id="3" label="livestore" status="success" message="updated → abc1234" />
        <TaskItem id="4" label="dotfiles" status="success" />
        <TaskItem id="5" label="schickling.dev" status="success" />
      </Box>
    )} initialState={null} />
  ),
}

export const SingleActive: Story = {
  render: () => (
    <TuiStoryPreview app={StaticApp} View={() => <TaskItem id="1" label="livestore" status="active" message="cloning..." />} initialState={null} />
  ),
}
