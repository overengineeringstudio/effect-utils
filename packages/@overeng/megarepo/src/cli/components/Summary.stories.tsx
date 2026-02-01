/**
 * Summary Stories
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { Box, Text } from '@overeng/tui-react'
import { createStaticApp, TuiStoryPreview } from '@overeng/tui-react/storybook'

const StaticApp = createStaticApp()

import { Summary } from './Summary.tsx'

// =============================================================================
// Meta
// =============================================================================

export default {
  title: 'Components/Summary',
  component: Summary,
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
} satisfies Meta<typeof Summary>

type Story = StoryObj<typeof Summary>

// =============================================================================
// Stories
// =============================================================================

export const MixedResults: Story = {
  render: () => (
    <TuiStoryPreview
      app={StaticApp}
      View={() => <Summary counts={{ cloned: 3, synced: 2, updated: 1, errors: 1 }} />}
      initialState={null}
    />
  ),
}

export const AllSuccess: Story = {
  render: () => (
    <TuiStoryPreview
      app={StaticApp}
      View={() => <Summary counts={{ synced: 5 }} />}
      initialState={null}
    />
  ),
}

export const WithErrors: Story = {
  render: () => (
    <TuiStoryPreview
      app={StaticApp}
      View={() => <Summary counts={{ synced: 3, errors: 2 }} />}
      initialState={null}
    />
  ),
}

export const AlreadySynced: Story = {
  render: () => (
    <TuiStoryPreview
      app={StaticApp}
      View={() => <Summary counts={{ alreadySynced: 5 }} />}
      initialState={null}
    />
  ),
}

export const NoChanges: Story = {
  render: () => (
    <TuiStoryPreview app={StaticApp} View={() => <Summary counts={{}} />} initialState={null} />
  ),
}

export const DryRunMode: Story = {
  render: () => (
    <TuiStoryPreview
      app={StaticApp}
      View={() => (
        <Box flexDirection="column" gap={1}>
          <Text bold>Dry run summary:</Text>
          <Summary counts={{ cloned: 3, synced: 2, updated: 1 }} dryRun />
        </Box>
      )}
      initialState={null}
    />
  ),
}

export const FullExample: Story = {
  render: () => (
    <TuiStoryPreview
      app={StaticApp}
      View={() => (
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
      )}
      initialState={null}
    />
  ),
}
