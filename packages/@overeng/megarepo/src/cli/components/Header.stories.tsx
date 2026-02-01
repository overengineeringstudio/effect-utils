/**
 * Header Stories
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { createStaticApp, TuiStoryPreview } from '@overeng/tui-react/storybook'

const StaticApp = createStaticApp()

import { Header } from './Header.tsx'

// =============================================================================
// Meta
// =============================================================================

export default {
  title: 'Components/Header',
  component: Header,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: `
Workspace header with name, path, and mode indicators.

Renders in expanded multi-line format:
\`\`\`
mr-workspace
  root: /path/to/workspace
  mode: dry run
\`\`\`
        `,
      },
    },
  },
} satisfies Meta<typeof Header>

type Story = StoryObj<typeof Header>

// =============================================================================
// Stories
// =============================================================================

export const Default: Story = {
  render: () => (
    <TuiStoryPreview app={StaticApp} View={() => <Header name="mr-workspace" root="/Users/dev/workspace" />} initialState={null} />
  ),
}

export const WithModes: Story = {
  render: () => (
    <TuiStoryPreview app={StaticApp} View={() => <Header name="mr-workspace" root="/Users/dev/workspace" modes={['dry run', 'frozen']} />} initialState={null} />
  ),
}

export const NameOnly: Story = {
  render: () => (
    <TuiStoryPreview app={StaticApp} View={() => <Header name="mr-workspace" />} initialState={null} />
  ),
}
