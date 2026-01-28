/**
 * Storybook stories for StoreFetchOutput component.
 */

import type { StoryObj } from '@storybook/react'
import { createCliMeta } from '@overeng/tui-react/storybook'
import { forceColorLevel } from '@overeng/cli-ui'
import { StoreFetchOutput, type StoreFetchOutputProps, type StoreFetchResult } from './StoreOutput.tsx'

forceColorLevel('truecolor')

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

const meta = createCliMeta<StoreFetchOutputProps>(StoreFetchOutput, {
  title: 'CLI/Store/Fetch',
  description: 'Output for the `mr store fetch` command. Shows fetch results for all repositories.',
  defaultArgs: {
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
})

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
