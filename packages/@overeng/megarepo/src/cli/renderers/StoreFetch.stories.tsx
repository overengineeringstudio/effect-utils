/**
 * Storybook stories for StoreFetch output.
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '@overeng/tui-react/storybook'

import {
  StoreView,
  StoreState,
  StoreAction,
  storeReducer,
  type StoreFetchResult,
} from './StoreOutput/mod.ts'

// =============================================================================
// Example Data
// =============================================================================

const exampleFetchResults: StoreFetchResult[] = [
  { path: 'github.com/effect-ts/effect', status: 'fetched' },
  { path: 'github.com/overengineeringstudio/effect-utils', status: 'fetched' },
  { path: 'github.com/schickling/dotfiles', status: 'error', message: 'network timeout' },
]

// =============================================================================
// State Factory
// =============================================================================

const createFetchState = (opts: {
  results: StoreFetchResult[]
  elapsedMs: number
}): typeof StoreState.Type => ({
  _tag: 'Fetch',
  basePath: '/Users/dev/.megarepo',
  results: opts.results,
  elapsedMs: opts.elapsedMs,
})

// =============================================================================
// Meta
// =============================================================================

const meta = {
  title: 'CLI/Store/Fetch',
  component: StoreView,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Output for the `mr store fetch` command. Shows fetch results for all repositories.',
      },
    },
  },
} satisfies Meta<typeof StoreView>

export default meta

type Story = StoryObj<typeof meta>

// =============================================================================
// Stories
// =============================================================================

export const Success: Story = {
  render: () => (
    <TuiStoryPreview
      View={StoreView}
      stateSchema={StoreState}
      actionSchema={StoreAction}
      reducer={storeReducer}
      initialState={createFetchState({
        results: [
          { path: 'github.com/effect-ts/effect', status: 'fetched' },
          { path: 'github.com/overengineeringstudio/effect-utils', status: 'fetched' },
          { path: 'github.com/schickling/dotfiles', status: 'fetched' },
        ],
        elapsedMs: 1850,
      })}
    />
  ),
}

export const WithErrors: Story = {
  render: () => (
    <TuiStoryPreview
      View={StoreView}
      stateSchema={StoreState}
      actionSchema={StoreAction}
      reducer={storeReducer}
      initialState={createFetchState({
        results: exampleFetchResults,
        elapsedMs: 3200,
      })}
    />
  ),
}

export const AllErrors: Story = {
  render: () => (
    <TuiStoryPreview
      View={StoreView}
      stateSchema={StoreState}
      actionSchema={StoreAction}
      reducer={storeReducer}
      initialState={createFetchState({
        results: [
          { path: 'github.com/effect-ts/effect', status: 'error', message: 'network timeout' },
          { path: 'github.com/private/repo', status: 'error', message: 'authentication failed' },
        ],
        elapsedMs: 30500,
      })}
    />
  ),
}
