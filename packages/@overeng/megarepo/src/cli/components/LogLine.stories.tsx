/**
 * LogLine Stories
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { Box } from '@overeng/tui-react'
import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import { LogLine } from './LogLine.tsx'

// =============================================================================
// Meta
// =============================================================================

export default {
  title: 'Components/LogLine',
  component: LogLine,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: `
Log entry with colored type indicator.

**Types:**
- info: cyan [i]
- warn: yellow [!]
- error: red [!]
        `,
      },
    },
  },
} satisfies Meta<typeof LogLine>

type Story = StoryObj<typeof LogLine>

// =============================================================================
// Stories
// =============================================================================

export const AllTypes: Story = {
  render: () => (
    <TuiStoryPreview>
      <Box flexDirection="column">
        <LogLine type="info" message="Cloning effect from github.com/Effect-TS/effect" />
        <LogLine type="warn" message="dotfiles has uncommitted changes, skipping" />
        <LogLine type="error" message="effect-utils: network timeout after 30s" />
      </Box>
    </TuiStoryPreview>
  ),
}

export const InfoLogs: Story = {
  render: () => (
    <TuiStoryPreview>
      <Box flexDirection="column">
        <LogLine type="info" message="Syncing livestore from github.com/livestore/livestore" />
        <LogLine type="info" message="Generated flake.nix" />
        <LogLine type="info" message="Generated .envrc" />
      </Box>
    </TuiStoryPreview>
  ),
}

export const ErrorLogs: Story = {
  render: () => (
    <TuiStoryPreview>
      <Box flexDirection="column">
        <LogLine type="error" message="effect-utils: network timeout after 30s" />
        <LogLine type="error" message="schickling.dev: authentication failed" />
      </Box>
    </TuiStoryPreview>
  ),
}
