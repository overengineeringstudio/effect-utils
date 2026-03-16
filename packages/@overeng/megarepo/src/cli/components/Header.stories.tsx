/**
 * WorkspaceRootLabel Stories
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { createStaticApp, TuiStoryPreview } from '@overeng/tui-react/storybook'

const StaticApp = createStaticApp()

import { WorkspaceRootLabel } from './Header.tsx'

// =============================================================================
// Meta
// =============================================================================

export default {
  title: 'Components/WorkspaceRootLabel',
  component: WorkspaceRootLabel,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component: `
Single-line workspace root label using abbreviated store path.

Renders: \`owner/repo@ref (modes)\`
        `,
      },
    },
  },
} satisfies Meta<typeof WorkspaceRootLabel>

type Story = StoryObj<typeof WorkspaceRootLabel>

// =============================================================================
// Stories
// =============================================================================

export const Default: Story = {
  render: () => (
    <TuiStoryPreview
      command="mr status"
      app={StaticApp}
      View={() => (
        <WorkspaceRootLabel storePath="/Users/dev/.megarepo/github.com/alice/dev-workspace/refs/heads/main" />
      )}
      initialState={null}
    />
  ),
}

export const WithModes: Story = {
  render: () => (
    <TuiStoryPreview
      command="mr fetch --dry-run"
      app={StaticApp}
      View={() => (
        <WorkspaceRootLabel
          storePath="/Users/dev/.megarepo/github.com/alice/dev-workspace/refs/heads/main"
          modes={['fetch', 'dry run']}
        />
      )}
      initialState={null}
    />
  ),
}

export const FeatureBranch: Story = {
  render: () => (
    <TuiStoryPreview
      command="mr status"
      app={StaticApp}
      View={() => (
        <WorkspaceRootLabel storePath="/Users/dev/.megarepo/github.com/acme-org/dev-tools/refs/heads/feature/new-ui" />
      )}
      initialState={null}
    />
  ),
}
