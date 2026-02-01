/**
 * Storybook stories for StoreFetchOutput component.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import {
  StoreFetchOutput,
  type StoreFetchOutputProps,
  type StoreFetchResult,
} from './StoreOutput.tsx'

// =============================================================================
// Example Data
// =============================================================================

const exampleFetchResults: StoreFetchResult[] = [
  { path: 'github.com/effect-ts/effect', status: 'fetched' },
  { path: 'github.com/overengineeringstudio/effect-utils', status: 'fetched' },
  { path: 'github.com/schickling/dotfiles', status: 'error', message: 'network timeout' },
]

// =============================================================================
// Meta
// =============================================================================

const meta = {
  title: 'CLI/Store/Fetch',
  component: StoreFetchOutput,
  render: (args) => (
    <TuiStoryPreview>
      <StoreFetchOutput {...args} />
    </TuiStoryPreview>
  ),
  args: {
    basePath: '/Users/dev/.megarepo',
    results: [],
    elapsedMs: 2350,
  },
  argTypes: {
    elapsedMs: {
      description: 'Elapsed time in milliseconds',
      control: { type: 'number' },
      table: { category: 'Performance' },
    },
  },
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Output for the `mr store fetch` command. Shows fetch results for all repositories.',
      },
    },
  },
} satisfies Meta<StoreFetchOutputProps>

export default meta

type Story = StoryObj<typeof meta>

// =============================================================================
// Stories
// =============================================================================

export const Success: Story = {
  args: {
    results: [
      { path: 'github.com/effect-ts/effect', status: 'fetched' },
      { path: 'github.com/overengineeringstudio/effect-utils', status: 'fetched' },
      { path: 'github.com/schickling/dotfiles', status: 'fetched' },
    ],
    elapsedMs: 1850,
  },
}

export const WithErrors: Story = {
  args: {
    results: exampleFetchResults,
    elapsedMs: 3200,
  },
}

export const AllErrors: Story = {
  args: {
    results: [
      { path: 'github.com/effect-ts/effect', status: 'error', message: 'network timeout' },
      { path: 'github.com/private/repo', status: 'error', message: 'authentication failed' },
    ],
    elapsedMs: 30500,
  },
}
