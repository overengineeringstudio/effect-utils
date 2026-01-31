/**
 * TaskItem Stories
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { Box } from '@overeng/tui-react'
import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { TaskItem } from './TaskItem.tsx'

// =============================================================================
// Meta
// =============================================================================

export default {
  title: 'Components/TaskItem',
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
} satisfies Meta

type Story = StoryObj

// =============================================================================
// Stories
// =============================================================================

export const AllStates: Story = {
  render: () => (
    <TuiStoryPreview>
      <Box flexDirection="column">
        <TaskItem id="1" label="effect" status="success" message="synced (main)" />
        <TaskItem id="2" label="effect-utils" status="success" message="updated → abc1234" />
        <TaskItem id="3" label="livestore" status="active" message="syncing..." />
        <TaskItem id="4" label="dotfiles" status="pending" />
        <TaskItem id="5" label="schickling.dev" status="pending" />
      </Box>
    </TuiStoryPreview>
  ),
}

export const WithErrors: Story = {
  render: () => (
    <TuiStoryPreview>
      <Box flexDirection="column">
        <TaskItem id="1" label="effect" status="success" message="synced (main)" />
        <TaskItem id="2" label="effect-utils" status="error" message="network timeout" />
        <TaskItem id="3" label="livestore" status="success" message="synced (main)" />
        <TaskItem id="4" label="dotfiles" status="skipped" message="dirty worktree" />
        <TaskItem id="5" label="schickling.dev" status="error" message="auth failed" />
      </Box>
    </TuiStoryPreview>
  ),
}

export const AllPending: Story = {
  render: () => (
    <TuiStoryPreview>
      <Box flexDirection="column">
        <TaskItem id="1" label="effect" status="pending" />
        <TaskItem id="2" label="effect-utils" status="pending" />
        <TaskItem id="3" label="livestore" status="pending" />
        <TaskItem id="4" label="dotfiles" status="pending" />
        <TaskItem id="5" label="schickling.dev" status="pending" />
      </Box>
    </TuiStoryPreview>
  ),
}

export const AllSuccess: Story = {
  render: () => (
    <TuiStoryPreview>
      <Box flexDirection="column">
        <TaskItem id="1" label="effect" status="success" message="synced (main)" />
        <TaskItem id="2" label="effect-utils" status="success" message="cloned (main)" />
        <TaskItem id="3" label="livestore" status="success" message="updated → abc1234" />
        <TaskItem id="4" label="dotfiles" status="success" />
        <TaskItem id="5" label="schickling.dev" status="success" />
      </Box>
    </TuiStoryPreview>
  ),
}

export const SingleActive: Story = {
  render: () => (
    <TuiStoryPreview>
      <TaskItem id="1" label="livestore" status="active" message="cloning..." />
    </TuiStoryPreview>
  ),
}
